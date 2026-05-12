import { describe, it, expect } from 'vitest';
import {
  parseYnabDate,
  parseYnabAmount,
  mapClearedStatus,
  isSplitRow,
  stripSplitIndicator,
  normalizeForMatch,
  shortHash,
  generateExternalId,
  extractLast4,
  accountsMatch,
  checkDedup,
  groupRows,
  buildSplitParentRow,
  buildSplitChildRows,
  buildRegularTransactionRow,
  resolveCategory,
  parseCsvLine,
  parseCsv,
  type YnabCsvRow,
  type ExistingTransactionSummary,
} from '../../scripts/import-ynab-transactions';

// ─── parseYnabDate ────────────────────────────────────────────────────────────

describe('parseYnabDate', () => {
  it('converts MM/DD/YYYY to YYYY-MM-DD', () => {
    expect(parseYnabDate('04/13/2026')).toBe('2026-04-13');
  });

  it('pads single-digit month and day', () => {
    expect(parseYnabDate('1/5/2025')).toBe('2025-01-05');
  });

  it('returns null for ISO format', () => {
    expect(parseYnabDate('2026-04-13')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseYnabDate('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseYnabDate('not a date')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseYnabDate('  04/03/2026  ')).toBe('2026-04-03');
  });
});

// ─── parseYnabAmount ──────────────────────────────────────────────────────────

describe('parseYnabAmount', () => {
  it('parses a plain decimal amount', () => {
    expect(parseYnabAmount('1000.00')).toBe(1000);
  });

  it('parses amount without leading zero', () => {
    expect(parseYnabAmount('.28')).toBeCloseTo(0.28);
  });

  it('strips dollar sign', () => {
    expect(parseYnabAmount('$1,234.56')).toBe(1234.56);
  });

  it('strips commas', () => {
    expect(parseYnabAmount('10,000.00')).toBe(10000);
  });

  it('returns 0 for empty string', () => {
    expect(parseYnabAmount('')).toBe(0);
  });

  it('returns 0 for "$0.00"', () => {
    expect(parseYnabAmount('$0.00')).toBe(0);
  });
});

// ─── mapClearedStatus ─────────────────────────────────────────────────────────

describe('mapClearedStatus', () => {
  it('maps "Cleared" to "cleared"', () => {
    expect(mapClearedStatus('Cleared')).toBe('cleared');
  });

  it('maps "Reconciled" to "cleared"', () => {
    expect(mapClearedStatus('Reconciled')).toBe('cleared');
  });

  it('maps "Uncleared" to "pending"', () => {
    expect(mapClearedStatus('Uncleared')).toBe('pending');
  });

  it('is case-insensitive', () => {
    expect(mapClearedStatus('CLEARED')).toBe('cleared');
    expect(mapClearedStatus('reconciled')).toBe('cleared');
    expect(mapClearedStatus('uncleared')).toBe('pending');
  });

  it('maps unknown values to "pending"', () => {
    expect(mapClearedStatus('')).toBe('pending');
    expect(mapClearedStatus('unknown')).toBe('pending');
  });
});

// ─── isSplitRow ───────────────────────────────────────────────────────────────

describe('isSplitRow', () => {
  it('returns true for "Split (1/9)"', () => {
    expect(isSplitRow('Split (1/9)')).toBe(true);
  });

  it('returns true for "Split (2/2)"', () => {
    expect(isSplitRow('Split (2/2)')).toBe(true);
  });

  it('returns true when split indicator is embedded in text', () => {
    expect(isSplitRow('Some prefix Split (1/3) some suffix')).toBe(true);
  });

  it('returns false for regular memo', () => {
    expect(isSplitRow('Grocery run')).toBe(false);
  });

  it('returns false for empty memo', () => {
    expect(isSplitRow('')).toBe(false);
  });
});

// ─── stripSplitIndicator ──────────────────────────────────────────────────────

describe('stripSplitIndicator', () => {
  it('strips "Split (1/9)" from memo', () => {
    expect(stripSplitIndicator('Split (1/9)')).toBe('');
  });

  it('strips split indicator and trims surrounding whitespace', () => {
    expect(stripSplitIndicator('  Split (2/3)  ')).toBe('');
  });

  it('leaves remaining text intact', () => {
    expect(stripSplitIndicator('Food Split (1/2) expenses')).toBe('Food  expenses');
  });

  it('leaves plain memo unchanged', () => {
    expect(stripSplitIndicator('Grocery run')).toBe('Grocery run');
  });
});

// ─── extractLast4 / accountsMatch ─────────────────────────────────────────────

describe('extractLast4', () => {
  it('extracts trailing 4-digit number', () => {
    expect(extractLast4('Chase ...1234')).toBe('1234');
  });

  it('extracts from BTS format "Checking (...5678)"', () => {
    expect(extractLast4('Checking (...5678)')).toBe('5678');
  });

  it('returns null when no 4-digit sequence found', () => {
    expect(extractLast4('Savings')).toBeNull();
  });

  it('returns null for short names', () => {
    expect(extractLast4('123')).toBeNull();
  });
});

describe('accountsMatch', () => {
  it('matches identical account names', () => {
    expect(accountsMatch('Checking', 'Checking')).toBe(true);
  });

  it('matches accounts sharing last-4 digits', () => {
    expect(accountsMatch('Food Lion ...1234', 'Chase Checking (...1234)')).toBe(true);
  });

  it('does not match accounts with different last-4 digits', () => {
    expect(accountsMatch('Account ...1234', 'Account ...5678')).toBe(false);
  });

  it('does not match when neither has 4-digit suffix', () => {
    expect(accountsMatch('Savings', 'Checking')).toBe(false);
  });
});

// ─── checkDedup ───────────────────────────────────────────────────────────────

describe('checkDedup', () => {
  const existing: ExistingTransactionSummary[] = [
    { externalId: 'YNAB-abc123', date: '2026-04-13', account: 'Savings', outflow: 28, inflow: 0 },
    { externalId: 'BTS-xyz789', date: '2026-04-15', account: 'Checking (...1234)', outflow: 50, inflow: 0 },
  ];

  it('tier 1: returns "skip" on exact external_id match', () => {
    expect(checkDedup('YNAB-abc123', '2026-04-13', 'Savings', 28, 0, existing)).toBe('skip');
  });

  it('tier 2: returns "probable_duplicate" on same date + account + amount', () => {
    expect(checkDedup('YNAB-newid', '2026-04-15', 'My Account ...1234', 50, 0, existing)).toBe('probable_duplicate');
  });

  it('tier 3: returns "insert" when no match found', () => {
    expect(checkDedup('YNAB-brand-new', '2026-05-01', 'Savings', 100, 0, existing)).toBe('insert');
  });

  it('tier 1 takes priority over tier 2', () => {
    // Even if date+account+amount also match, tier 1 wins
    expect(checkDedup('YNAB-abc123', '2026-04-13', 'Savings', 28, 0, existing)).toBe('skip');
  });

  it('amount tolerance is within 0.005', () => {
    expect(checkDedup('YNAB-newid', '2026-04-13', 'Savings', 28.001, 0, existing)).toBe('probable_duplicate');
    expect(checkDedup('YNAB-newid', '2026-04-13', 'Savings', 28.01, 0, existing)).toBe('insert');
  });

  it('returns "insert" for empty existing list', () => {
    expect(checkDedup('YNAB-anything', '2026-04-13', 'Savings', 28, 0, [])).toBe('insert');
  });
});

// ─── groupRows ────────────────────────────────────────────────────────────────

const makeRow = (overrides: Partial<YnabCsvRow>): YnabCsvRow => ({
  account: '360 Savings',
  flag: '',
  rawDate: '04/13/2026',
  date: '2026-04-13',
  payee: 'Test Payee',
  categoryGroupCategory: '',
  categoryGroup: '',
  category: 'Groceries',
  memo: '',
  rawOutflow: '10.00',
  rawInflow: '0.00',
  outflow: 10,
  inflow: 0,
  cleared: 'Cleared',
  ...overrides,
});

describe('groupRows', () => {
  it('keeps non-split rows as solo groups', () => {
    const rows = [makeRow({}), makeRow({ payee: 'Another' })];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isSplit)).toBe(true);
  });

  it('groups consecutive split rows with same date + account', () => {
    const rows = [
      makeRow({ memo: 'Split (1/3)', rawOutflow: '.28' }),
      makeRow({ memo: 'Split (2/3)', rawOutflow: '.13' }),
      makeRow({ memo: 'Split (3/3)', rawOutflow: '.05' }),
    ];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSplit).toBe(true);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('does not group split rows with different accounts', () => {
    const rows = [
      makeRow({ account: 'Savings', memo: 'Split (1/2)' }),
      makeRow({ account: 'Checking', memo: 'Split (2/2)' }),
    ];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].isSplit).toBe(true);
    expect(groups[1].isSplit).toBe(true);
  });

  it('does not group split rows with different dates', () => {
    const rows = [
      makeRow({ date: '2026-04-13', memo: 'Split (1/2)' }),
      makeRow({ date: '2026-04-14', memo: 'Split (2/2)' }),
    ];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(2);
  });

  it('handles mix of split groups and solo rows', () => {
    const rows = [
      makeRow({ payee: 'Solo1' }),
      makeRow({ memo: 'Split (1/2)', payee: 'ChildA' }),
      makeRow({ memo: 'Split (2/2)', payee: 'ChildB' }),
      makeRow({ payee: 'Solo2' }),
    ];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(3);
    expect(groups[0].isSplit).toBe(false);
    expect(groups[1].isSplit).toBe(true);
    expect(groups[1].rows).toHaveLength(2);
    expect(groups[2].isSplit).toBe(false);
  });
});

// ─── buildSplitParentRow ──────────────────────────────────────────────────────

const TRANSACTIONS_COLUMNS = [
  'transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
  'imported_at', 'status', 'date', 'payee', 'description', 'category',
  'suggested_category', 'category_subgroup', 'category_group', 'category_type',
  'outflow', 'inflow', 'account', 'memo', 'transaction_type', 'transfer_pair_id',
  'flag', 'needs_reimbursement', 'reimbursement_amount', 'matched_id', 'reviewed',
];
const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);

describe('buildSplitParentRow', () => {
  const splitGroup = [
    makeRow({ memo: 'Split (1/2)', rawOutflow: '.28', outflow: 0.28, payee: 'Food Lion' }),
    makeRow({ memo: 'Split (2/2)', rawOutflow: '.13', outflow: 0.13, payee: 'ACLU' }),
  ];
  const importedAt = '2026-05-01T00:00:00.000Z';

  it('sets source to ynab_import', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('source')]).toBe('ynab_import');
  });

  it('sets payee from first child', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('payee')]).toBe('Food Lion');
  });

  it('sums outflow from all children', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parseFloat(parentRow[col('outflow')])).toBeCloseTo(0.41);
  });

  it('leaves category blank', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('category')]).toBe('');
  });

  it('leaves parent_id blank (it is the parent)', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('parent_id')]).toBe('');
  });

  it('transaction_id starts with YNAB-SPLIT-', () => {
    const { parentRow, parentId } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('transaction_id')]).toBe(parentId);
    expect(parentId).toMatch(/^YNAB-SPLIT-/);
  });

  it('splitGroupId equals parentId', () => {
    const { parentId, splitGroupId } = buildSplitParentRow(splitGroup, importedAt);
    expect(splitGroupId).toBe(parentId);
  });

  it('is deterministic — same input produces same parentId', () => {
    const { parentId: id1 } = buildSplitParentRow(splitGroup, importedAt);
    const { parentId: id2 } = buildSplitParentRow(splitGroup, importedAt);
    expect(id1).toBe(id2);
  });

  it('sets category_group and category_subgroup to empty string', () => {
    const { parentRow } = buildSplitParentRow(splitGroup, importedAt);
    expect(parentRow[col('category_group')]).toBe('');
    expect(parentRow[col('category_subgroup')]).toBe('');
  });
});

// ─── buildSplitChildRows ──────────────────────────────────────────────────────

describe('buildSplitChildRows', () => {
  const group = [
    makeRow({ memo: 'Split (1/2)', category: 'Groceries', rawOutflow: '.28', outflow: 0.28 }),
    makeRow({ memo: 'Split (2/2)', category: 'Dining Out', rawOutflow: '.13', outflow: 0.13 }),
  ];
  const categoryIndex = new Map([['Groceries', 'Groceries 🛒'], ['Dining Out', 'Dining Out 🧑‍🍳']]);
  const importedAt = '2026-05-01T00:00:00.000Z';
  const parentId = 'YNAB-SPLIT-2026-04-13-savings-abc123';
  const splitGroupId = parentId;

  it('returns one row per child', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    expect(rows).toHaveLength(2);
  });

  it('sets parent_id on each child', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    expect(rows[0][col('parent_id')]).toBe(parentId);
    expect(rows[1][col('parent_id')]).toBe(parentId);
  });

  it('strips Split (N/M) from memo', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    expect(rows[0][col('memo')]).not.toMatch(/Split/i);
    expect(rows[1][col('memo')]).not.toMatch(/Split/i);
  });

  it('resolves category to canonical name', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    expect(rows[0][col('category')]).toBe('Groceries 🛒');
    expect(rows[1][col('category')]).toBe('Dining Out 🧑‍🍳');
  });

  it('sets split_group_id on each child', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    expect(rows[0][col('split_group_id')]).toBe(splitGroupId);
  });

  it('leaves category_group and category_subgroup blank', () => {
    const rows = buildSplitChildRows(group, parentId, splitGroupId, importedAt, categoryIndex);
    for (const row of rows) {
      expect(row[col('category_group')]).toBe('');
      expect(row[col('category_subgroup')]).toBe('');
    }
  });
});

// ─── buildRegularTransactionRow ───────────────────────────────────────────────

describe('buildRegularTransactionRow', () => {
  const r = makeRow({ category: 'Groceries', cleared: 'Cleared', memo: 'Weekly shop' });
  const categoryIndex = new Map([['Groceries', 'Groceries 🛒']]);
  const importedAt = '2026-05-01T00:00:00.000Z';

  it('sets source to ynab_import', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('source')]).toBe('ynab_import');
  });

  it('maps Cleared status correctly', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('status')]).toBe('cleared');
  });

  it('resolves category to canonical name', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('category')]).toBe('Groceries 🛒');
  });

  it('sets empty parent_id and split_group_id', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('parent_id')]).toBe('');
    expect(row[col('split_group_id')]).toBe('');
  });

  it('leaves category_group and category_subgroup blank', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('category_group')]).toBe('');
    expect(row[col('category_subgroup')]).toBe('');
  });

  it('transaction_id equals external_id', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('transaction_id')]).toBe(row[col('external_id')]);
  });

  it('sets reviewed to FALSE', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('reviewed')]).toBe('FALSE');
  });

  it('preserves memo', () => {
    const row = buildRegularTransactionRow(r, importedAt, categoryIndex);
    expect(row[col('memo')]).toBe('Weekly shop');
  });
});

// ─── resolveCategory ─────────────────────────────────────────────────────────

describe('resolveCategory', () => {
  const categoryIndex = new Map([
    ['Groceries', 'Groceries 🛒'],
    ['Dining Out', 'Dining Out 🧑‍🍳'],
    ['Ready to Assign', 'Ready to Assign'],
  ]);

  it('returns canonical name for exact ASCII match', () => {
    expect(resolveCategory('Groceries', categoryIndex)).toBe('Groceries 🛒');
  });

  it('returns canonical name when input has emoji encoding artifacts', () => {
    // YNAB might export "Groceries üõí" where üõí are encoding artifacts for 🛒
    // normalizeForMatch strips non-ASCII → "Groceries" → matches
    expect(resolveCategory('Groceries üõí', categoryIndex)).toBe('Groceries 🛒');
  });

  it('returns empty string for unmatched category', () => {
    expect(resolveCategory('Unknown Category', categoryIndex)).toBe('');
  });

  it('handles Inflow: Ready to Assign with colon prefix', () => {
    // The category column already has just "Ready to Assign" (not "Inflow: Ready to Assign")
    expect(resolveCategory('Ready to Assign', categoryIndex)).toBe('Ready to Assign');
  });
});

// ─── parseCsvLine ─────────────────────────────────────────────────────────────

describe('parseCsvLine', () => {
  it('splits a plain comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with commas inside', () => {
    expect(parseCsvLine('"hello, world",b,c')).toEqual(['hello, world', 'b', 'c']);
  });

  it('handles escaped double quotes inside quoted field', () => {
    expect(parseCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
  });

  it('handles empty fields', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('parses a YNAB-style header line', () => {
    const line = 'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared';
    const fields = parseCsvLine(line);
    expect(fields).toHaveLength(11);
    expect(fields[0]).toBe('Account');
    expect(fields[10]).toBe('Cleared');
  });
});

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  const ynabCsv = [
    'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
    '360 Performance Savings,,04/13/2026,Environmental Defense Fund,Fixed Annual: Charitable,Fixed Annual,Cash Charitable Giving,Split (1/9),.28,.00,Uncleared',
    '360 Performance Savings,,04/13/2026,ACLU of Maryland,Fixed Annual: Charitable,Fixed Annual,Cash Charitable Giving,Split (2/9),.13,.00,Uncleared',
    '360 Performance Savings,,04/03/2026,Fintech,Inflow: Ready to Assign,Inflow,Ready to Assign,Split (1/2),.00,.00,Cleared',
    '360 Performance Savings,,04/03/2026,Fintech,Savings: EVEN tax year,Savings,EVEN tax year,Split (2/2),.00,.02,Cleared',
    'Checking Account,,04/20/2026,Grocery Store,,Food & Dining,Groceries,,25.00,.00,Cleared',
  ].join('\n');

  it('parses the correct number of rows', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows).toHaveLength(5);
  });

  it('parses date into YYYY-MM-DD format', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[0].date).toBe('2026-04-13');
  });

  it('parses outflow amount', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[0].outflow).toBeCloseTo(0.28);
  });

  it('parses inflow amount', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[3].inflow).toBeCloseTo(0.02);
  });

  it('preserves memo text', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[0].memo).toBe('Split (1/9)');
  });

  it('sets account correctly', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[4].account).toBe('Checking Account');
  });

  it('sets category correctly', () => {
    const rows = parseCsv(ynabCsv);
    expect(rows[4].category).toBe('Groceries');
  });

  it('returns empty array for empty CSV', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('skips rows with unparseable dates but parses rest', () => {
    const csv = [
      'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
      '360 Savings,,BAD DATE,Test Payee,,,Cat,,10.00,.00,Cleared',
      '360 Savings,,04/01/2026,Test Payee,,,Cat,,10.00,.00,Cleared',
    ].join('\n');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-04-01');
  });
});

// ─── generateExternalId (determinism) ─────────────────────────────────────────

describe('generateExternalId', () => {
  it('produces same id for same inputs', () => {
    const id1 = generateExternalId('Savings', '2026-04-13', 'Food Lion', '.28', '.00', 'Split (1/9)');
    const id2 = generateExternalId('Savings', '2026-04-13', 'Food Lion', '.28', '.00', 'Split (1/9)');
    expect(id1).toBe(id2);
  });

  it('produces different id when memo differs', () => {
    const id1 = generateExternalId('Savings', '2026-04-13', 'Food Lion', '.28', '.00', 'Split (1/9)');
    const id2 = generateExternalId('Savings', '2026-04-13', 'Food Lion', '.28', '.00', 'Split (2/9)');
    expect(id1).not.toBe(id2);
  });

  it('starts with "YNAB-"', () => {
    const id = generateExternalId('Savings', '2026-04-13', 'Test', '.00', '.00', '');
    expect(id).toMatch(/^YNAB-/);
  });
});

// ─── shortHash ───────────────────────────────────────────────────────────────

describe('shortHash', () => {
  it('returns a 12-character hex string', () => {
    const h = shortHash('a', 'b', 'c');
    expect(h).toHaveLength(12);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    expect(shortHash('x', 'y')).toBe(shortHash('x', 'y'));
  });

  it('changes when inputs change', () => {
    expect(shortHash('a', 'b')).not.toBe(shortHash('b', 'a'));
  });
});
