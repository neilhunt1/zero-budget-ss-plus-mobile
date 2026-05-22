import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../src/db/schema';
import {
  getTransactionsByMonth,
  getRecentTransactions,
  searchTransactions,
  getTransactionsByCategory,
  getTransactionsByAccount,
  getCategorySuggestions,
  getAccountSuggestions,
  getPayeeSuggestions,
  getTransactionsByPayee,
  getUnreviewedCount,
  getActiveBudgetCategories,
  getMonthAssignments,
  getSuggestedCategory,
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

describe('getRecentTransactions', () => {
  beforeEach(resetDb);

  it('returns transactions within the given day window, newest-first', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date();
    old.setDate(old.getDate() - 91);
    const oldDate = old.toISOString().slice(0, 10);

    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'recent', date: today }),
      makeTx({ transaction_id: 'old', date: oldDate }),
    ]);

    const result = await getRecentTransactions(90);
    expect(result.map((t) => t.transaction_id)).toEqual(['recent']);
  });

  it('excludes split children', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'parent', date: today }),
      makeTx({ transaction_id: 'child', date: today, parent_id: 'parent' }),
    ]);

    const result = await getRecentTransactions(90);
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

  it('includes split children so they are discoverable by search', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'parent', payee: 'Daffy Charitable' }),
      makeTx({ transaction_id: 'child', payee: 'EUMC Laurel', parent_id: 'parent' }),
    ]);

    const result = await searchTransactions('eumc');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('child');
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

describe('getSuggestedCategory', () => {
  beforeEach(resetDb);

  it('returns category of most recent reviewed transaction with matching payee', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'old', payee: 'Countdown', date: '2025-03-01', reviewed: true, category: 'Groceries 🛒' }),
      makeTx({ transaction_id: 'new', payee: 'Countdown', date: '2025-04-01', reviewed: true, category: 'Household 🏠' }),
    ]);

    expect(await getSuggestedCategory('Countdown')).toBe('Household 🏠');
  });

  it('is case-insensitive', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'COUNTDOWN', reviewed: true, category: 'Groceries 🛒' }),
    ]);

    expect(await getSuggestedCategory('countdown')).toBe('Groceries 🛒');
    expect(await getSuggestedCategory('Countdown')).toBe('Groceries 🛒');
    expect(await getSuggestedCategory('COUNTDOWN')).toBe('Groceries 🛒');
  });

  it('ignores unreviewed transactions', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Countdown', reviewed: false, category: 'Groceries 🛒' }),
    ]);

    expect(await getSuggestedCategory('Countdown')).toBeNull();
  });

  it('ignores transactions with empty category', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Countdown', reviewed: true, category: '' }),
    ]);

    expect(await getSuggestedCategory('Countdown')).toBeNull();
  });

  it('returns null when no matching payee found', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Petrol Station', reviewed: true, category: 'Fuel ⛽' }),
    ]);

    expect(await getSuggestedCategory('Countdown')).toBeNull();
  });

  it('returns null for empty db', async () => {
    expect(await getSuggestedCategory('Countdown')).toBeNull();
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

describe('getCategorySuggestions', () => {
  beforeEach(resetDb);

  it('returns active categories matching partial query case-insensitively', async () => {
    await db.budgetCategories.bulkPut([
      makeCat({ category: 'Groceries 🛒', sort_order: 1, active: true }),
      makeCat({ category: 'Fuel ⛽', sort_order: 2, active: true }),
      makeCat({ category: 'Amara Summer Care ⛺️', sort_order: 3, active: true }),
      makeCat({ category: 'Emory Summer Care ⛺️', sort_order: 4, active: true }),
    ]);

    const result = await getCategorySuggestions('summ');
    expect(result).toEqual(['Amara Summer Care ⛺️', 'Emory Summer Care ⛺️']);
  });

  it('excludes inactive categories', async () => {
    await db.budgetCategories.bulkPut([
      makeCat({ category: 'Active Groceries', sort_order: 1, active: true }),
      makeCat({ category: 'Inactive Groceries', sort_order: 2, active: false }),
    ]);

    const result = await getCategorySuggestions('groceries');
    expect(result).toEqual(['Active Groceries']);
  });

  it('returns at most 6 results', async () => {
    await db.budgetCategories.bulkPut(
      Array.from({ length: 10 }, (_, i) =>
        makeCat({ category: `Category ${i}`, sort_order: i, active: true })
      )
    );

    const result = await getCategorySuggestions('category');
    expect(result).toHaveLength(6);
  });

  it('returns empty array when no match', async () => {
    await db.budgetCategories.bulkPut([makeCat({ category: 'Groceries', sort_order: 1, active: true })]);
    expect(await getCategorySuggestions('zzz')).toEqual([]);
  });
});

describe('getAccountSuggestions', () => {
  beforeEach(resetDb);

  it('returns unique accounts matching partial query case-insensitively', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', account: 'Capital One Checking' }),
      makeTx({ transaction_id: 'b', account: 'Capital One Savings' }),
      makeTx({ transaction_id: 'c', account: 'Chase Freedom' }),
      makeTx({ transaction_id: 'd', account: 'Capital One Checking' }), // duplicate account
    ]);

    const result = await getAccountSuggestions('capita');
    expect(result).toEqual(['Capital One Checking', 'Capital One Savings']);
  });

  it('returns at most 6 unique accounts', async () => {
    await db.transactions.bulkPut(
      Array.from({ length: 8 }, (_, i) =>
        makeTx({ transaction_id: `t${i}`, account: `Bank Account ${i}` })
      )
    );

    const result = await getAccountSuggestions('bank');
    expect(result).toHaveLength(6);
  });

  it('returns empty array when no match', async () => {
    await db.transactions.bulkPut([makeTx({ transaction_id: 'x', account: 'Chase Freedom' })]);
    expect(await getAccountSuggestions('zzz')).toEqual([]);
  });
});

describe('getPayeeSuggestions', () => {
  beforeEach(resetDb);

  it('returns payees matching partial query case-insensitively', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Amazon Prime' }),
      makeTx({ transaction_id: 'b', payee: 'Amazon Fresh' }),
      makeTx({ transaction_id: 'c', payee: 'Netflix' }),
    ]);

    const result = await getPayeeSuggestions('amaz');
    expect(result).toContain('Amazon Prime');
    expect(result).toContain('Amazon Fresh');
    expect(result).not.toContain('Netflix');
  });

  it('deduplicates payees across transactions', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Whole Foods' }),
      makeTx({ transaction_id: 'b', payee: 'Whole Foods' }),
    ]);

    const result = await getPayeeSuggestions('whole');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Whole Foods');
  });

  it('returns at most 6 results', async () => {
    await db.transactions.bulkPut(
      Array.from({ length: 8 }, (_, i) =>
        makeTx({ transaction_id: `t${i}`, payee: `Payee Store ${i}` })
      )
    );

    const result = await getPayeeSuggestions('payee');
    expect(result).toHaveLength(6);
  });

  it('returns empty array when no match', async () => {
    await db.transactions.bulkPut([makeTx({ transaction_id: 'x', payee: 'Starbucks' })]);
    expect(await getPayeeSuggestions('zzz')).toEqual([]);
  });
});

describe('getTransactionsByPayee', () => {
  beforeEach(resetDb);

  it('returns only transactions with the exact payee, newest-first', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', payee: 'Amazon', date: '2025-04-01' }),
      makeTx({ transaction_id: 'b', payee: 'Amazon', date: '2025-04-10' }),
      makeTx({ transaction_id: 'c', payee: 'Netflix', date: '2025-04-05' }),
    ]);

    const result = await getTransactionsByPayee('Amazon');
    expect(result.map((t) => t.transaction_id)).toEqual(['b', 'a']);
  });

  it('returns empty array when no match', async () => {
    await db.transactions.bulkPut([makeTx({ transaction_id: 'x', payee: 'Starbucks' })]);
    expect(await getTransactionsByPayee('Amazon')).toEqual([]);
  });
});

describe('getTransactionsByAccount', () => {
  beforeEach(resetDb);

  it('returns only transactions for the given account, newest-first', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', account: 'Checking', date: '2025-04-01' }),
      makeTx({ transaction_id: 'b', account: 'Checking', date: '2025-04-10' }),
      makeTx({ transaction_id: 'c', account: 'Savings', date: '2025-04-05' }),
    ]);

    const result = await getTransactionsByAccount('Checking');
    expect(result.map((t) => t.transaction_id)).toEqual(['b', 'a']);
  });

  it('narrows by textQuery when provided', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', account: 'Checking', payee: 'Amazon' }),
      makeTx({ transaction_id: 'b', account: 'Checking', payee: 'Netflix' }),
    ]);

    const result = await getTransactionsByAccount('Checking', 'amazon');
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('a');
  });

  it('textQuery matches category and memo too', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'a', account: 'Checking', payee: 'Store', category: 'Groceries', memo: '' }),
      makeTx({ transaction_id: 'b', account: 'Checking', payee: 'Store', category: 'Fuel', memo: 'road trip' }),
    ]);

    expect(await getTransactionsByAccount('Checking', 'groceries')).toHaveLength(1);
    expect(await getTransactionsByAccount('Checking', 'road trip')).toHaveLength(1);
  });

  it('includes split children', async () => {
    await db.transactions.bulkPut([
      makeTx({ transaction_id: 'parent', account: 'Checking', payee: 'Daffy Charitable' }),
      makeTx({ transaction_id: 'child', account: 'Checking', payee: 'EUMC Laurel', parent_id: 'parent' }),
    ]);

    const result = await getTransactionsByAccount('Checking');
    expect(result).toHaveLength(2);
  });
});
