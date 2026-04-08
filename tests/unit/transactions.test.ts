import { describe, it, expect } from 'vitest';
import { computeCategoryActivity } from '../../src/api/transactions';
import { Transaction } from '../../src/types/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _id = 1;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: `tx-${_id++}`,
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2025-04-01',
    payee: 'Test Payee',
    description: '',
    category: 'Groceries',
    suggested_category: '',
    category_subgroup: '',
    category_group: 'Food & Dining',
    category_type: 'fluid',
    outflow: 0,
    inflow: 0,
    account: 'Checking',
    memo: '',
    transaction_type: 'debit',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    _rowIndex: 2,
    ...overrides,
  };
}

// ─── computeCategoryActivity ──────────────────────────────────────────────────

describe('computeCategoryActivity', () => {
  it('returns activity = outflow − inflow per category', () => {
    const txs = [makeTx({ category: 'Groceries', outflow: 120, inflow: 0 })];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(120);
  });

  it('subtracts inflow from outflow (e.g. refund reduces activity)', () => {
    const txs = [
      makeTx({ category: 'Dining Out', outflow: 80, inflow: 0 }),
      makeTx({ category: 'Dining Out', outflow: 0, inflow: 20 }), // refund
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Dining Out')).toBe(60);
  });

  it('accumulates multiple transactions in the same category', () => {
    const txs = [
      makeTx({ category: 'Groceries', outflow: 200 }),
      makeTx({ category: 'Groceries', outflow: 150 }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(350);
  });

  it('tracks multiple categories independently', () => {
    const txs = [
      makeTx({ category: 'Groceries', outflow: 300 }),
      makeTx({ category: 'Gas', outflow: 60 }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(300);
    expect(result.get('Gas')).toBe(60);
  });

  it('excludes transfer transactions entirely', () => {
    const txs = [
      makeTx({ category: 'Savings', outflow: 1000, transaction_type: 'transfer' }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.has('Savings')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('excludes transactions with no category', () => {
    const txs = [makeTx({ category: '', outflow: 50 })];
    const result = computeCategoryActivity(txs);
    expect(result.size).toBe(0);
  });

  it('returns an empty map for an empty transaction list', () => {
    expect(computeCategoryActivity([])).toEqual(new Map());
  });
});
