import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from '../../src/types';
import type { SheetsClient } from '../../src/api/client';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdate = vi.fn();
const mockPut = vi.fn();

vi.mock('../../src/db/schema', () => ({
  db: {
    transactions: {
      update: (...args: unknown[]) => mockUpdate(...args),
      put: (...args: unknown[]) => mockPut(...args),
    },
  },
}));

const mockUpdateTransactionFields = vi.fn();

vi.mock('../../src/api/transactions', () => ({
  updateTransactionFields: (...args: unknown[]) => mockUpdateTransactionFields(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 'tx-1',
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2026-01-15',
    payee: 'Whole Foods',
    description: '',
    category: 'Groceries',
    suggested_category: '',
    category_subgroup: '',
    category_group: 'Food & Dining',
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
    reviewed: true,
    _rowIndex: 5,
    ...overrides,
  };
}

function mockClient(): SheetsClient {
  return {
    getValues: vi.fn(),
    updateValues: vi.fn(),
    appendValues: vi.fn(),
    batchUpdateValues: vi.fn(),
    batchUpdate: vi.fn(),
    updateToken: vi.fn(),
  } as unknown as SheetsClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('optimisticEditTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
    mockPut.mockResolvedValue(undefined);
    mockUpdateTransactionFields.mockResolvedValue(undefined);
  });

  it('updates IndexedDB then writes to Sheets with only the changed fields', async () => {
    const { optimisticEditTransaction } = await import('../../src/db/optimisticWrites');
    const tx = makeTx();
    const client = mockClient();
    const changes: Partial<Transaction> = { payee: 'Trader Joes', memo: 'weekly shop' };

    await optimisticEditTransaction(tx, changes, client);

    expect(mockUpdate).toHaveBeenCalledWith('tx-1', changes);
    expect(mockUpdateTransactionFields).toHaveBeenCalledWith(client, 5, changes);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('reverts IndexedDB to original transaction when Sheets write fails', async () => {
    const { optimisticEditTransaction } = await import('../../src/db/optimisticWrites');
    const tx = makeTx();
    const client = mockClient();
    const changes: Partial<Transaction> = { category: 'Dining Out' };
    mockUpdateTransactionFields.mockRejectedValue(new Error('network error'));

    await expect(optimisticEditTransaction(tx, changes, client)).rejects.toThrow('network error');

    expect(mockUpdate).toHaveBeenCalledWith('tx-1', changes);
    expect(mockPut).toHaveBeenCalledWith(tx);
  });

  it('passes rowIndex from the original transaction to the Sheets write', async () => {
    const { optimisticEditTransaction } = await import('../../src/db/optimisticWrites');
    const tx = makeTx({ _rowIndex: 42 });
    const client = mockClient();

    await optimisticEditTransaction(tx, { reviewed: false }, client);

    expect(mockUpdateTransactionFields).toHaveBeenCalledWith(client, 42, { reviewed: false });
  });
});
