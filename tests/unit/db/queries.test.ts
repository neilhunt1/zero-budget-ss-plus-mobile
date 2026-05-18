import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../src/db/schema';
import {
  getTransactionsByMonth,
  searchTransactions,
  getTransactionsByCategory,
  getUnreviewedCount,
  getActiveBudgetCategories,
  getMonthAssignments,
} from '../../../src/db/queries';
import type { Transaction, BudgetCategory, BudgetAssignment } from '../../../src/types';

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
    category_group: '',
    category_type: '',
    outflow: 10,
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
    _rowIndex: 2,
    ...overrides,
  };
}

function makeCat(overrides: Partial<BudgetCategory> & { category: string }): BudgetCategory {
  return {
    category_group: 'Living',
    category_subgroup: 'Food',
    category_type: 'fluid',
    monthly_template_amount: 0,
    sort_order: 1,
    active: true,
    _rowIndex: 7,
    ...overrides,
  };
}

function makeAssignment(month: string, category: string, assigned: number): BudgetAssignment {
  return { month, category, assigned, source: 'manual', _rowIndex: 509 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getTransactionsByMonth', () => {
  beforeEach(resetDb);

  it('returns only transactions in the given month, newest-first', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'march', date: '2025-03-15' }),
      makeTx({ transaction_id: 'april-1', date: '2025-04-01' }),
      makeTx({ transaction_id: 'april-30', date: '2025-04-30' }),
    ]);

    const result = await getTransactionsByMonth('2025-04');
    expect(result.map((t) => t.transaction_id)).toEqual(['april-30', 'april-1']);
  });

  it('excludes split children (parent_id set)', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'parent', date: '2025-04-10' }),
      makeTx({ transaction_id: 'child', date: '2025-04-10', parent_id: 'parent' }),
    ]);

    const result = await getTransactionsByMonth('2025-04');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('parent');
  });
});

describe('searchTransactions', () => {
  beforeEach(resetDb);

  it('matches payee case-insensitively', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Countdown Supermarket' }),
      makeTx({ transaction_id: 'b', payee: 'Petrol Station' }),
    ]);

    const result = await searchTransactions('countdown');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('a');
  });

  it('matches category', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', category: 'Groceries 🛒' }),
      makeTx({ transaction_id: 'b', category: 'Fuel ⛽' }),
    ]);

    const result = await searchTransactions('groceries');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('a');
  });

  it('matches memo case-insensitively', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', memo: 'Family dinner' }),
      makeTx({ transaction_id: 'b', memo: 'Work lunch' }),
    ]);

    expect(await searchTransactions('dinner')).toHaveLength(1);
    expect(await searchTransactions('lunch')).toHaveLength(1);
    expect(await searchTransactions('breakfast')).toHaveLength(0);
  });

  it('excludes split children', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'parent', payee: 'Supermarket' }),
      makeTx({ transaction_id: 'child', payee: 'Supermarket', parent_id: 'parent' }),
    ]);

    const result = await searchTransactions('supermarket');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('parent');
  });
});

describe('getTransactionsByCategory', () => {
  beforeEach(resetDb);

  it('returns only transactions matching the category', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', category: 'Groceries 🛒' }),
      makeTx({ transaction_id: 'b', category: 'Fuel ⛽' }),
    ]);

    const result = await getTransactionsByCategory('Groceries 🛒');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('a');
  });
});

describe('getUnreviewedCount', () => {
  beforeEach(resetDb);

  it('counts only unreviewed non-child transactions', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'reviewed', reviewed: true }),
      makeTx({ transaction_id: 'unreviewed-1', reviewed: false }),
      makeTx({ transaction_id: 'unreviewed-2', reviewed: false }),
      makeTx({ transaction_id: 'child', reviewed: false, parent_id: 'reviewed' }),
    ]);

    expect(await getUnreviewedCount()).toBe(2);
  });

  it('returns 0 when all are reviewed', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', reviewed: true }),
    ]);
    expect(await getUnreviewedCount()).toBe(0);
  });
});

describe('getActiveBudgetCategories', () => {
  beforeEach(resetDb);

  it('returns only active categories, sorted by sort_order', async () => {
    await db.budgetCategories.bulkPut([
      makeCat({ category: 'B', sort_order: 2, active: true }),
      makeCat({ category: 'A', sort_order: 1, active: true }),
      makeCat({ category: 'C', sort_order: 3, active: false }),
    ]);

    const result = await getActiveBudgetCategories();
    expect(result.map((c) => c.category)).toEqual(['A', 'B']);
  });
});

describe('getMonthAssignments', () => {
  beforeEach(resetDb);

  it('returns assignments only for the given month', async () => {
    await db.budgetAssignments.bulkPut([
      makeAssignment('2025-03', 'Groceries 🛒', 300),
      makeAssignment('2025-04', 'Groceries 🛒', 400),
      makeAssignment('2025-04', 'Fuel ⛽', 100),
    ]);

    const result = await getMonthAssignments('2025-04');
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.category).sort()).toEqual(['Fuel ⛽', 'Groceries 🛒']);
  });
});
