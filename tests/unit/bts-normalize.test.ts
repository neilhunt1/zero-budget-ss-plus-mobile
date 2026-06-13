import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseBtsDate,
  parseBtsAmount,
  selectBtsPayee,
  normalizeBtsRow,
  normalizeBtsTransactions,
} from '../../src/api/bts';
import type { SheetsClient } from '../../src/api/client';

// ─── parseBtsDate ─────────────────────────────────────────────────────────────

describe('parseBtsDate', () => {
  it('converts MM/DD/YYYY to YYYY-MM-DD', () => {
    expect(parseBtsDate('05/22/2026')).toBe('2026-05-22');
  });

  it('zero-pads single-digit month and day', () => {
    expect(parseBtsDate('1/7/2025')).toBe('2025-01-07');
  });

  it('handles December 31', () => {
    expect(parseBtsDate('12/31/2025')).toBe('2025-12-31');
  });

  it('returns input unchanged if not parseable', () => {
    expect(parseBtsDate('')).toBe('');
    expect(parseBtsDate('2025-04-01')).toBe('2025-04-01');
  });
});

// ─── parseBtsAmount ───────────────────────────────────────────────────────────

describe('parseBtsAmount', () => {
  it('strips dollar sign and spaces', () => {
    expect(parseBtsAmount('$ 25.00')).toBe(25);
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseBtsAmount(' $10.5 ')).toBe(10.5);
  });

  it('handles zero', () => {
    expect(parseBtsAmount('0')).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseBtsAmount('')).toBe(0);
  });

  it('handles plain number without symbol', () => {
    expect(parseBtsAmount('42.99')).toBe(42.99);
  });
});

// ─── selectBtsPayee ───────────────────────────────────────────────────────────

describe('selectBtsPayee', () => {
  it('uses merchant when present', () => {
    expect(selectBtsPayee('Trader Joe\'s', 'TRDRS JOES #123')).toBe('Trader Joe\'s');
  });

  it('falls back to description when merchant is empty', () => {
    expect(selectBtsPayee('', 'ACH TRANSFER')).toBe('ACH TRANSFER');
  });

  it('falls back to description when merchant is only whitespace', () => {
    expect(selectBtsPayee('   ', 'ACH TRANSFER')).toBe('ACH TRANSFER');
  });

  it('returns Unknown when both are empty', () => {
    expect(selectBtsPayee('', '')).toBe('Unknown');
  });

  it('trims whitespace from result', () => {
    expect(selectBtsPayee('  Costco  ', '')).toBe('Costco');
  });
});

// ─── normalizeBtsRow ──────────────────────────────────────────────────────────

describe('normalizeBtsRow', () => {
  const sample = {
    Transaction_id: 'abc123',
    Date: '05/22/2026',
    pending: 'FALSE',
    Description: 'COSTCO WHSE #0001',
    Merchant: 'Costco',
    Outflow: '$ 87.43',
    Inflow: '',
    Auto_Category: 'Groceries',
    Account: 'Capital One 360 Checking (6650)',
    Memo: 'test memo',
  };

  it('sets transaction_id with BTS- prefix', () => {
    expect(normalizeBtsRow(sample).transaction_id).toBe('BTS-abc123');
  });

  it('sets external_id to the raw BTS Transaction_id', () => {
    expect(normalizeBtsRow(sample).external_id).toBe('abc123');
  });

  it('sets source to banksheets', () => {
    expect(normalizeBtsRow(sample).source).toBe('banksheets');
  });

  it('maps cleared status when pending=FALSE', () => {
    expect(normalizeBtsRow(sample).status).toBe('cleared');
  });

  it('maps pending status when pending=TRUE', () => {
    expect(normalizeBtsRow({ ...sample, pending: 'TRUE' }).status).toBe('pending');
  });

  it('parses date from MM/DD/YYYY', () => {
    expect(normalizeBtsRow(sample).date).toBe('2026-05-22');
  });

  it('uses Merchant as payee', () => {
    expect(normalizeBtsRow(sample).payee).toBe('Costco');
  });

  it('falls back to Description when Merchant is empty', () => {
    expect(normalizeBtsRow({ ...sample, Merchant: '' }).payee).toBe('COSTCO WHSE #0001');
  });

  it('computes signed amount (outflow → negative)', () => {
    expect(normalizeBtsRow(sample).amount).toBe(-87.43);
  });

  it('computes signed amount (inflow → positive)', () => {
    expect(normalizeBtsRow({ ...sample, Outflow: '$ 0.00', Inflow: '$ 100.00' }).amount).toBe(100);
  });

  it('maps suggested_category from Auto Category', () => {
    expect(normalizeBtsRow(sample).suggested_category).toBe('Groceries');
  });

  it('maps account', () => {
    expect(normalizeBtsRow(sample).account).toBe('Capital One 360 Checking (6650)');
  });

  it('sets reviewed=false', () => {
    expect(normalizeBtsRow(sample).reviewed).toBe(false);
  });

  it('sets transaction_type=regular', () => {
    expect(normalizeBtsRow(sample).transaction_type).toBe('regular');
  });

  it('sets category to empty string', () => {
    expect(normalizeBtsRow(sample).category).toBe('');
  });
});

// ─── normalizeBtsTransactions ─────────────────────────────────────────────────

// BTS tab header row
const BTS_HEADER = [
  'Transaction_id', 'Date', 'pending', 'Description', 'City',
  'Merchant', 'Outflow', 'Inflow', 'Auto Category', 'Account', 'Memo', 'Sent',
];

// One sample BTS data row (in header order)
const BTS_DATA_ROW = [
  'bts-001', '05/22/2026', 'FALSE', 'WHOLE FOODS #123', 'Austin',
  'Whole Foods', '$ 45.00', '', 'Groceries', 'Chase Checking', '', '',
];

function makeBtsDataRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const row = [...BTS_DATA_ROW];
  for (const [key, val] of Object.entries(overrides)) {
    const idx = BTS_HEADER.indexOf(key);
    if (idx !== -1) row[idx] = val;
  }
  return row;
}

function mockClient(opts: {
  btsRows?: string[][];
  existingExtIds?: Array<[string, string, string]>; // [external_id, imported_at, status]
}): SheetsClient {
  const btsValues = [BTS_HEADER, ...(opts.btsRows ?? [BTS_DATA_ROW])];
  // existingExtIds maps to Transactions!E2:G rows
  const extValues = (opts.existingExtIds ?? []).map(([eid, imp, st]) => [eid, imp, st]);

  // Simulate the column-A occupancy used by nextTransactionRow(): header + one
  // row per existing transaction so the function returns a sensible next row.
  const colAValues = [
    ['transaction_id'],
    ...Array(opts.existingExtIds?.length ?? 0).fill(['BTS-placeholder']),
  ];

  return {
    getValues: vi.fn().mockImplementation((range: string) => {
      if (range.startsWith('Transactions (BTS)')) return Promise.resolve({ values: btsValues });
      if (range.startsWith('Transactions!E2')) return Promise.resolve({ values: extValues });
      if (range === 'Transactions!A:A') return Promise.resolve({ values: colAValues });
      return Promise.resolve({ values: [] });
    }),
    appendValues: vi.fn().mockResolvedValue(undefined),
    updateValues: vi.fn().mockResolvedValue(undefined),
    batchUpdate: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn(),
  } as unknown as SheetsClient;
}

describe('normalizeBtsTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a new BTS row not already in Transactions', async () => {
    const client = mockClient({ btsRows: [BTS_DATA_ROW], existingExtIds: [] });
    const result = await normalizeBtsTransactions(client);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    // appendTransactions uses INSERT_ROWS append anchored to the last data row
    expect(client.appendValues).toHaveBeenCalledOnce();
    const [range] = vi.mocked(client.appendValues).mock.calls[0];
    expect(range).toMatch(/^Transactions!A\d+$/); // anchor, e.g. Transactions!A2
    expect(vi.mocked(client.appendValues).mock.calls[0][2]).toBe('INSERT_ROWS');
  });

  it('skips a row whose external_id already exists (cleared, no change)', async () => {
    const client = mockClient({
      btsRows: [BTS_DATA_ROW],
      existingExtIds: [['bts-001', '2026-05-01T00:00:00Z', 'cleared']],
    });
    const result = await normalizeBtsTransactions(client);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
    expect(client.updateValues).not.toHaveBeenCalled();
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('handles pending → cleared transition', async () => {
    const pendingRow = makeBtsDataRow({ pending: 'FALSE' }); // now cleared in BTS
    const client = mockClient({
      btsRows: [pendingRow],
      existingExtIds: [['bts-001', '2026-05-01T00:00:00Z', 'pending']],
    });
    const result = await normalizeBtsTransactions(client);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(client.updateValues).toHaveBeenCalledOnce();
    // Verify the status update call targets the right field
    const callArgs = vi.mocked(client.updateValues).mock.calls[0];
    expect(callArgs[0]).toMatch(/Transactions!G/); // G = status column
    expect(callArgs[1]).toEqual([['cleared']]);
  });

  it('does not update status when existing is already cleared', async () => {
    const clearedRow = makeBtsDataRow({ pending: 'FALSE' });
    const client = mockClient({
      btsRows: [clearedRow],
      existingExtIds: [['bts-001', '2026-05-01T00:00:00Z', 'cleared']],
    });
    const result = await normalizeBtsTransactions(client);
    expect(result.updated).toBe(0);
    expect(client.updateValues).not.toHaveBeenCalled();
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('returns 0,0 when BTS tab has no data rows', async () => {
    const client = mockClient({ btsRows: [] });
    const result = await normalizeBtsTransactions(client);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('skips BTS rows with no Transaction_id', async () => {
    const emptyIdRow = makeBtsDataRow({ Transaction_id: '' });
    const client = mockClient({ btsRows: [emptyIdRow], existingExtIds: [] });
    const result = await normalizeBtsTransactions(client);
    expect(result.inserted).toBe(0);
    expect(client.updateValues).not.toHaveBeenCalled();
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('inserts multiple new rows and skips duplicates', async () => {
    const row2 = makeBtsDataRow({ Transaction_id: 'bts-002' });
    const client = mockClient({
      btsRows: [BTS_DATA_ROW, row2],
      existingExtIds: [['bts-001', '2026-05-01T00:00:00Z', 'cleared']],
    });
    const result = await normalizeBtsTransactions(client);
    expect(result.inserted).toBe(1); // only bts-002 is new
    // All new rows go in a single appendValues call (INSERT_ROWS)
    expect(client.appendValues).toHaveBeenCalledOnce();
    const [range] = vi.mocked(client.appendValues).mock.calls[0];
    expect(range).toMatch(/^Transactions!A\d+$/);
  });
});
