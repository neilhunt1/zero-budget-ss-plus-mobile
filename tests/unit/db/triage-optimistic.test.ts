import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../../../src/db/schema';
import {
  optimisticApproveIncome,
  optimisticConfirmTransfer,
  optimisticAssignPurchase,
} from '../../../src/db/optimisticWrites';
import type { Transaction, BudgetCategory } from '../../../src/types';

vi.mock('../../../src/api/transactions', () => ({
  updateTransactionFields: vi.fn(),
}));

import { updateTransactionFields } from '../../../src/api/transactions';
const mockUpdate = updateTransactionFields as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resetDb() {
  await db.delete();
  await db.open();
}

function makeTx(overrides: Partial<Transaction> & { transaction_id: string }): Transaction {
  return {
    transaction_id: overrides.transaction_id,
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2025-04-01',
    payee: 'Test Payee',
    description: '',
    category: 'Groceries 🛒',
    suggested_category: '',
    category_subgroup: '',
    category_group: 'Living',
    category_type: 'fluid',
    outflow: 50,
    inflow: 0,
    account: 'Checking',
    memo: '',
    transaction_type: 'regular',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    _rowIndex: 5,
    ...overrides,
  };
}

function makeCat(category: string): BudgetCategory {
  return {
    category,
    category_group: 'Living',
    category_subgroup: 'Food',
    category_type: 'fluid',
    monthly_template_amount: 0,
    sort_order: 1,
    active: true,
    _rowIndex: 7,
  };
}

const fakeClient = {} as any;

// ─── optimisticApproveIncome ──────────────────────────────────────────────────

describe('optimisticApproveIncome', () => {
  beforeEach(async () => {
    await resetDb();
    mockUpdate.mockReset();
  });

  it('updates IndexedDB immediately before Sheets write completes', async () => {
    const tx = makeTx({ transaction_id: 'tx1', transaction_type: 'income', reviewed: false });
    await db.transactions.put(tx);

    let dbStateAtSheetsWrite: Transaction | undefined;
    mockUpdate.mockImplementation(async () => {
      dbStateAtSheetsWrite = await db.transactions.get('tx1');
    });

    await optimisticApproveIncome(tx, fakeClient);

    expect(dbStateAtSheetsWrite?.reviewed).toBe(true);
    expect(dbStateAtSheetsWrite?.transaction_type).toBe('income');
  });

  it('leaves transaction approved when Sheets write succeeds', async () => {
    const tx = makeTx({ transaction_id: 'tx1', transaction_type: 'income', reviewed: false });
    await db.transactions.put(tx);
    mockUpdate.mockResolvedValue(undefined);

    await optimisticApproveIncome(tx, fakeClient);

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(true);
    expect(result?.transaction_type).toBe('income');
  });

  it('reverts IndexedDB to original state when Sheets write fails', async () => {
    const tx = makeTx({
      transaction_id: 'tx1',
      transaction_type: 'regular',
      category: 'Groceries 🛒',
      reviewed: false,
    });
    await db.transactions.put(tx);
    mockUpdate.mockRejectedValue(new Error('Network error'));

    await expect(optimisticApproveIncome(tx, fakeClient)).rejects.toThrow('Network error');

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(false);
    expect(result?.transaction_type).toBe('regular');
    expect(result?.category).toBe('Groceries 🛒');
  });
});

// ─── optimisticConfirmTransfer ────────────────────────────────────────────────

describe('optimisticConfirmTransfer', () => {
  beforeEach(async () => {
    await resetDb();
    mockUpdate.mockReset();
  });

  it('marks the transaction as a transfer in IndexedDB', async () => {
    const tx = makeTx({ transaction_id: 'tx1', reviewed: false });
    await db.transactions.put(tx);
    mockUpdate.mockResolvedValue(undefined);

    await optimisticConfirmTransfer(tx, null, fakeClient);

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(true);
    expect(result?.transaction_type).toBe('transfer');
  });

  it('links the pair transaction in IndexedDB when provided', async () => {
    const tx = makeTx({ transaction_id: 'tx1', account: 'Checking', reviewed: false });
    const pair = makeTx({ transaction_id: 'tx2', account: 'Savings', reviewed: false, transfer_pair_id: '' });
    await db.transactions.bulkPut([tx, pair]);
    mockUpdate.mockResolvedValue(undefined);

    await optimisticConfirmTransfer(tx, pair, fakeClient);

    const updatedPair = await db.transactions.get('tx2');
    expect(updatedPair?.transfer_pair_id).toBe('tx1');
  });

  it('reverts both tx and pair in IndexedDB when Sheets write fails', async () => {
    const tx = makeTx({ transaction_id: 'tx1', account: 'Checking', reviewed: false });
    const pair = makeTx({ transaction_id: 'tx2', account: 'Savings', reviewed: false, transfer_pair_id: '' });
    await db.transactions.bulkPut([tx, pair]);
    mockUpdate.mockRejectedValue(new Error('Timeout'));

    await expect(optimisticConfirmTransfer(tx, pair, fakeClient)).rejects.toThrow('Timeout');

    const revertedTx = await db.transactions.get('tx1');
    const revertedPair = await db.transactions.get('tx2');
    expect(revertedTx?.reviewed).toBe(false);
    expect(revertedPair?.transfer_pair_id).toBe('');
  });

  it('saves credit_payment type when explicitly passed', async () => {
    const tx = makeTx({ transaction_id: 'tx1', account: 'Checking', reviewed: false });
    const pair = makeTx({ transaction_id: 'tx2', account: 'Chase CREDIT CARD', reviewed: false, transfer_pair_id: '' });
    await db.transactions.bulkPut([tx, pair]);
    mockUpdate.mockResolvedValue(undefined);

    await optimisticConfirmTransfer(tx, pair, fakeClient, 'credit_payment');

    const result = await db.transactions.get('tx1');
    expect(result?.transaction_type).toBe('credit_payment');
    expect(result?.transfer_pair_id).toBe('tx2');
  });
});

// ─── optimisticAssignPurchase ─────────────────────────────────────────────────

describe('optimisticAssignPurchase', () => {
  beforeEach(async () => {
    await resetDb();
    mockUpdate.mockReset();
  });

  it('assigns category and marks reviewed in IndexedDB', async () => {
    const tx = makeTx({ transaction_id: 'tx1', category: '', reviewed: false });
    await db.transactions.put(tx);
    mockUpdate.mockResolvedValue(undefined);

    const catRecord = makeCat('Groceries 🛒');
    await optimisticAssignPurchase(tx, 'Groceries 🛒', catRecord, fakeClient);

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(true);
    expect(result?.category).toBe('Groceries 🛒');
    expect(result?.category_group).toBe('Living');
    expect(result?.transaction_type).toBe('regular');
  });

  it('allows empty category (Ready to Assign)', async () => {
    const tx = makeTx({ transaction_id: 'tx1', category: 'Groceries 🛒', reviewed: false });
    await db.transactions.put(tx);
    mockUpdate.mockResolvedValue(undefined);

    await optimisticAssignPurchase(tx, '', undefined, fakeClient);

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(true);
    expect(result?.category).toBe('');
  });

  it('reverts IndexedDB to original state when Sheets write fails', async () => {
    const tx = makeTx({ transaction_id: 'tx1', category: '', reviewed: false });
    await db.transactions.put(tx);
    mockUpdate.mockRejectedValue(new Error('Forbidden'));

    const catRecord = makeCat('Groceries 🛒');
    await expect(
      optimisticAssignPurchase(tx, 'Groceries 🛒', catRecord, fakeClient)
    ).rejects.toThrow('Forbidden');

    const result = await db.transactions.get('tx1');
    expect(result?.reviewed).toBe(false);
    expect(result?.category).toBe('');
  });
});
