import { describe, it, expect } from 'vitest';
import {
  parseYnabAmount,
  normalizeForMatch,
  stripGroupPrefix,
  parseYnabMonth,
  buildOpeningTransactions,
  applyYnabAssignments,
  type AccountBalance,
  type YnabPlanRow,
} from '../../scripts/sync-from-ynab';

// ─── parseYnabAmount ──────────────────────────────────────────────────────────

describe('parseYnabAmount', () => {
  it('parses a plain dollar amount', () => {
    expect(parseYnabAmount('1000.00')).toBe(1000);
  });

  it('strips the dollar sign', () => {
    expect(parseYnabAmount('$1,234.56')).toBe(1234.56);
  });

  it('strips commas from large amounts', () => {
    expect(parseYnabAmount('10,000.00')).toBe(10000);
  });

  it('handles negative amounts', () => {
    expect(parseYnabAmount('-$100.00')).toBe(-100);
  });

  it('returns 0 for empty string', () => {
    expect(parseYnabAmount('')).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(parseYnabAmount('n/a')).toBe(0);
  });
});

// ─── normalizeForMatch ────────────────────────────────────────────────────────

describe('normalizeForMatch', () => {
  it('leaves plain ASCII names unchanged', () => {
    expect(normalizeForMatch('Groceries')).toBe('Groceries');
  });

  it('strips emoji from a category name and trims', () => {
    // "Groceries 🛒" → strip non-ASCII → "Groceries " → trim → "Groceries"
    expect(normalizeForMatch('Groceries 🛒')).toBe('Groceries');
  });

  it('strips YNAB encoding artifacts', () => {
    // These are the artifact sequences from YNAB CSV exports
    expect(normalizeForMatch('üõí')).toBe('');
    expect(normalizeForMatch('üßë')).toBe('');
  });

  it('trims leading/trailing whitespace after stripping', () => {
    expect(normalizeForMatch('  Groceries  ')).toBe('Groceries');
  });

  it('returns empty string for an all-emoji name', () => {
    expect(normalizeForMatch('🛒')).toBe('');
  });
});

// ─── stripGroupPrefix ────────────────────────────────────────────────────────

describe('stripGroupPrefix', () => {
  it('strips a group prefix from the combined column', () => {
    expect(stripGroupPrefix('Monthly Expenses: Groceries 🛒')).toBe('Groceries 🛒');
  });

  it('returns the original string when no colon-space separator exists', () => {
    expect(stripGroupPrefix('Groceries')).toBe('Groceries');
  });

  it('handles groups with colons in the category name', () => {
    // Only the FIRST ": " is treated as a separator
    expect(stripGroupPrefix('Kids & School: School: Supplies')).toBe('School: Supplies');
  });

  it('handles Credit Card Payments prefix', () => {
    expect(stripGroupPrefix('Credit Card Payments: Disney Visa')).toBe('Disney Visa');
  });
});

// ─── parseYnabMonth ──────────────────────────────────────────────────────────

describe('parseYnabMonth', () => {
  it('converts "Apr 2026" to "2026-04"', () => {
    expect(parseYnabMonth('Apr 2026')).toBe('2026-04');
  });

  it('converts "Jan 2025" to "2025-01"', () => {
    expect(parseYnabMonth('Jan 2025')).toBe('2025-01');
  });

  it('converts "Dec 2024" to "2024-12"', () => {
    expect(parseYnabMonth('Dec 2024')).toBe('2024-12');
  });

  it('returns null for unknown month abbreviation', () => {
    expect(parseYnabMonth('Foo 2026')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseYnabMonth('2026-04')).toBeNull();
    expect(parseYnabMonth('')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseYnabMonth('  Apr 2026  ')).toBe('2026-04');
  });
});

// ─── buildOpeningTransactions ─────────────────────────────────────────────────

describe('buildOpeningTransactions', () => {
  const fixedNow = new Date('2026-04-25T12:00:00.000Z');

  it('creates one row per depository account', () => {
    const accounts: AccountBalance[] = [
      { account: 'Checking', balance: 5000 },
      { account: 'Savings', balance: 10000 },
    ];
    const rows = buildOpeningTransactions(accounts, fixedNow);
    expect(rows).toHaveLength(2);
  });

  it('skips credit accounts (negative balance)', () => {
    const accounts: AccountBalance[] = [
      { account: 'Checking', balance: 5000 },
      { account: 'Disney Visa', balance: -1500 },
      { account: 'Amex', balance: -300 },
    ];
    const rows = buildOpeningTransactions(accounts, fixedNow);
    expect(rows).toHaveLength(1);
    // account column is index 17; only the Checking row should appear
    expect(rows[0][17]).toBe('Checking');
  });

  it('skips accounts with zero balance', () => {
    const accounts: AccountBalance[] = [{ account: 'Checking', balance: 0 }];
    const rows = buildOpeningTransactions(accounts, fixedNow);
    expect(rows).toHaveLength(0);
  });

  it('sets source=seed on every row', () => {
    const accounts: AccountBalance[] = [{ account: 'Checking', balance: 1000 }];
    const [row] = buildOpeningTransactions(accounts, fixedNow);
    expect(row[3]).toBe('seed'); // source is column index 3
  });

  it('sets payee to "Opening Balance"', () => {
    const accounts: AccountBalance[] = [{ account: 'Checking', balance: 1000 }];
    const [row] = buildOpeningTransactions(accounts, fixedNow);
    const payeeIdx = ['transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
      'imported_at', 'status', 'date', 'payee'].indexOf('payee');
    expect(row[payeeIdx]).toBe('Opening Balance');
  });

  it('uses the balance as the inflow amount', () => {
    const accounts: AccountBalance[] = [{ account: 'Checking', balance: 4567.89 }];
    const [row] = buildOpeningTransactions(accounts, fixedNow);
    // inflow is at index 16
    expect(row[16]).toBe('4567.89');
  });

  it('generates deterministic transaction_id from account name', () => {
    const accounts: AccountBalance[] = [{ account: 'My Checking Account', balance: 100 }];
    const [row] = buildOpeningTransactions(accounts, fixedNow);
    expect(row[0]).toBe('seed_my_checking_account');
  });

  it('produces identical rows on repeated calls with same input', () => {
    const accounts: AccountBalance[] = [{ account: 'Checking', balance: 5000 }];
    const rows1 = buildOpeningTransactions(accounts, fixedNow);
    const rows2 = buildOpeningTransactions(accounts, fixedNow);
    expect(rows1).toEqual(rows2);
  });
});

// ─── applyYnabAssignments (isIdempotent) ──────────────────────────────────────

describe('applyYnabAssignments', () => {
  const ynabRows: YnabPlanRow[] = [
    { month: '2026-04', category: 'Groceries 🛒', assigned: 1000 },
    { month: '2026-04', category: 'Dining Out 🧑‍🍳', assigned: 365 },
    { month: '2026-03', category: 'Groceries 🛒', assigned: 950 },
  ];

  it('produces correct rows from empty state', () => {
    const result = applyYnabAssignments([], ynabRows);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r[3] === 'ynab_import')).toBe(true);
  });

  it('preserves non-ynab_import rows', () => {
    const existing: string[][] = [
      ['2026-04', 'Groceries 🛒', '800', 'manual'],
      ['2026-04', 'Rent', '2000', 'template'],
    ];
    const result = applyYnabAssignments(existing, ynabRows);
    const manual = result.filter((r) => r[3] === 'manual');
    const template = result.filter((r) => r[3] === 'template');
    expect(manual).toHaveLength(1);
    expect(template).toHaveLength(1);
  });

  it('isIdempotent: running twice produces identical state', () => {
    const initial: string[][] = [
      ['2026-04', 'Rent', '2000', 'manual'],
    ];

    const after1 = applyYnabAssignments(initial, ynabRows);
    const after2 = applyYnabAssignments(after1, ynabRows);

    expect(after1).toEqual(after2);
  });

  it('isIdempotent: empty initial state, running twice is identical', () => {
    const after1 = applyYnabAssignments([], ynabRows);
    const after2 = applyYnabAssignments(after1, ynabRows);
    expect(after1).toEqual(after2);
  });

  it('replaces existing ynab_import rows — no duplicates', () => {
    const existing: string[][] = [
      ['2026-04', 'Groceries 🛒', '900', 'ynab_import'],
    ];
    const result = applyYnabAssignments(existing, ynabRows);
    const groceriesRows = result.filter(
      (r) => r[1] === 'Groceries 🛒' && r[0] === '2026-04'
    );
    // Should be exactly one row for Apr 2026 Groceries (the new value, not old)
    expect(groceriesRows).toHaveLength(1);
    expect(groceriesRows[0][2]).toBe('1000');
  });
});
