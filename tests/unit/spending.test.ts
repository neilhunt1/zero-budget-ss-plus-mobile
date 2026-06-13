import { describe, it, expect } from 'vitest';
import { aggregateSpending, presetToDateRange } from '../../src/api/spending';
import type { Transaction } from '../../src/types';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    transaction_id: 'id',
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2024-03-15',
    payee: '',
    description: '',
    category: '',
    suggested_category: '',
    category_subgroup: '',
    category_group: '',
    category_type: '',
    amount: 0,
    account: '',
    memo: '',
    transaction_type: 'regular',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    ...overrides,
  };
}

describe('aggregateSpending', () => {
  it('groups outflows by category_group', () => {
    const txns = [
      tx({ category_group: 'Food', category: 'Groceries 🛒', amount: -100 }),
      tx({ category_group: 'Food', category: 'Restaurants', amount: -50 }),
      tx({ category_group: 'Transport', category: 'Gas', amount: -40 }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(2);
    expect(result[0].group).toBe('Food');
    expect(result[0].total).toBe(150);
    expect(result[1].group).toBe('Transport');
    expect(result[1].total).toBe(40);
  });

  it('excludes transfers', () => {
    const txns = [
      tx({ category_group: 'Food', amount: -100 }),
      tx({ category_group: 'Savings', amount: -500, transaction_type: 'transfer' }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('Food');
  });

  it('excludes income transactions (transaction_type = income)', () => {
    const txns = [
      tx({ category_group: 'Income', amount: 5000, transaction_type: 'income' }),
      tx({ category_group: 'Food', amount: -100 }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('Food');
  });

  it('excludes credit_payment transactions', () => {
    const txns = [
      tx({ category_group: 'Food', amount: -100 }),
      tx({ amount: -500, transaction_type: 'credit_payment' }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('Food');
  });

  it('nets inflow (refund/credit) against outflow within the same category', () => {
    // 2000 + 3000 outflow, 5600 refund → net -600 (category shows as negative spend)
    const txns = [
      tx({ category_group: 'Housing', category: 'Escrow', amount: -2000 }),
      tx({ category_group: 'Housing', category: 'Escrow', amount: -3000 }),
      tx({ category_group: 'Housing', category: 'Escrow', amount: 5600 }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(1);
    expect(result[0].total).toBeCloseTo(-600); // net negative = net credit month
  });

  it('shows category with positive net after inflow netting', () => {
    const txns = [
      tx({ category_group: 'Housing', category: 'Escrow', amount: -6000 }),
      tx({ category_group: 'Housing', category: 'Escrow', amount: 1000 }), // partial refund
    ];
    const result = aggregateSpending(txns, null);
    expect(result).toHaveLength(1);
    expect(result[0].total).toBeCloseTo(5000); // 6000 - 1000
  });

  it('filters by selectedCategories when provided', () => {
    const txns = [
      tx({ category_group: 'Food', category: 'Groceries', amount: -100 }),
      tx({ category_group: 'Fun', category: 'Movies', amount: -30 }),
    ];
    const result = aggregateSpending(txns, new Set(['Groceries']));
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('Food');
  });

  it('sorts groups by total descending', () => {
    const txns = [
      tx({ category_group: 'A', amount: -10 }),
      tx({ category_group: 'B', amount: -200 }),
      tx({ category_group: 'C', amount: -50 }),
    ];
    const result = aggregateSpending(txns, null);
    expect(result.map((r) => r.group)).toEqual(['B', 'C', 'A']);
  });

  it('returns empty array for no qualifying transactions', () => {
    const result = aggregateSpending([], null);
    expect(result).toEqual([]);
  });
});

describe('presetToDateRange', () => {
  // Use local-time constructor to avoid UTC-midnight timezone shift
  const today = new Date(2024, 2, 15); // March 15, 2024

  it('mtd returns first of month to today', () => {
    const { start, end } = presetToDateRange('mtd', today);
    expect(start).toBe('2024-03-01');
    expect(end).toBe('2024-03-15');
  });

  it('last_month returns prior month', () => {
    const { start, end } = presetToDateRange('last_month', today);
    expect(start).toBe('2024-02-01');
    expect(end).toBe('2024-02-29'); // 2024 is a leap year
  });

  it('ytd returns jan 1 to today', () => {
    const { start, end } = presetToDateRange('ytd', today);
    expect(start).toBe('2024-01-01');
    expect(end).toBe('2024-03-15');
  });

  it('last_year returns full prior year', () => {
    const { start, end } = presetToDateRange('last_year', today);
    expect(start).toBe('2023-01-01');
    expect(end).toBe('2023-12-31');
  });

  it('last_3_months starts 3 months back', () => {
    const { start, end } = presetToDateRange('last_3_months', today);
    expect(start).toBe('2023-12-01');
    expect(end).toBe('2024-03-15');
  });
});
