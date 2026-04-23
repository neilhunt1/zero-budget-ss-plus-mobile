import { describe, it, expect, vi } from 'vitest';
import { fetchTransactions } from '../../src/api/transactions';
import type { SheetsClient } from '../../src/api/client';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockClient(values: string[][]): SheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue({ values }),
    updateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue(undefined),
    batchUpdate: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn(),
  } as unknown as SheetsClient;
}

// Build a sparse transaction row. Columns map to COLS in transactions.ts:
// 0=transaction_id, 1=parent_id, 2=split_group_id, 3=source, 4=external_id,
// 5=imported_at, 6=status, 7=date, 8=payee, 9=description, 10=category,
// 11=suggested_category, 12=category_subgroup, 13=category_group,
// 14=category_type, 15=outflow, 16=inflow, 17=account, 18=memo,
// 19=transaction_type, 20=transfer_pair_id, ...
function txRow(overrides: {
  id?: string;
  parentId?: string;
  date?: string;
  category?: string;
  outflow?: string;
  inflow?: string;
  type?: string; // transaction_type
} = {}): string[] {
  const row = new Array(26).fill('');
  row[0] = overrides.id ?? 'tx-1';
  row[1] = overrides.parentId ?? '';
  row[7] = overrides.date ?? '2025-04-01';
  row[10] = overrides.category ?? 'Groceries';
  row[15] = overrides.outflow ?? '0';
  row[16] = overrides.inflow ?? '0';
  row[19] = overrides.type ?? 'debit';
  return row;
}

// ─── fetchTransactions ────────────────────────────────────────────────────────

describe('fetchTransactions', () => {
  it('returns empty array when sheet has no data', async () => {
    expect(await fetchTransactions(mockClient([]))).toEqual([]);
  });

  it('filters out rows with no transaction_id', async () => {
    const client = mockClient([
      txRow({ id: 'tx-1' }),
      new Array(26).fill(''), // empty row
    ]);
    const result = await fetchTransactions(client);
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('tx-1');
  });

  it('excludes split children (parent_id set) by default', async () => {
    const client = mockClient([
      txRow({ id: 'parent' }),
      txRow({ id: 'child', parentId: 'parent' }),
    ]);
    const result = await fetchTransactions(client);
    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe('parent');
  });

  it('includes split children when includeSplitChildren is true', async () => {
    const client = mockClient([
      txRow({ id: 'parent' }),
      txRow({ id: 'child', parentId: 'parent' }),
    ]);
    const result = await fetchTransactions(client, { includeSplitChildren: true });
    expect(result).toHaveLength(2);
  });

  it('filters by month prefix', async () => {
    const client = mockClient([
      txRow({ id: 'tx-march', date: '2025-03-15' }),
      txRow({ id: 'tx-april', date: '2025-04-01' }),
      txRow({ id: 'tx-april-2', date: '2025-04-20' }),
    ]);
    const result = await fetchTransactions(client, { month: '2025-04' });
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.date.startsWith('2025-04'))).toBe(true);
  });

  it('sorts results newest-first', async () => {
    const client = mockClient([
      txRow({ id: 'tx-old', date: '2025-03-01' }),
      txRow({ id: 'tx-new', date: '2025-04-15' }),
      txRow({ id: 'tx-mid', date: '2025-04-01' }),
    ]);
    const result = await fetchTransactions(client);
    expect(result[0].transaction_id).toBe('tx-new');
    expect(result[1].transaction_id).toBe('tx-mid');
    expect(result[2].transaction_id).toBe('tx-old');
  });

  it('applies limit after sorting', async () => {
    const client = mockClient([
      txRow({ id: 'tx-1', date: '2025-04-01' }),
      txRow({ id: 'tx-2', date: '2025-04-02' }),
      txRow({ id: 'tx-3', date: '2025-04-03' }),
    ]);
    const result = await fetchTransactions(client, { limit: 2 });
    expect(result).toHaveLength(2);
    // limit after sort, so we get the 2 newest
    expect(result[0].transaction_id).toBe('tx-3');
    expect(result[1].transaction_id).toBe('tx-2');
  });

  it('parses outflow and inflow as floats', async () => {
    const client = mockClient([
      txRow({ id: 'tx-1', outflow: '42.50', inflow: '10.00' }),
    ]);
    const [tx] = await fetchTransactions(client);
    expect(tx.outflow).toBe(42.5);
    expect(tx.inflow).toBe(10.0);
  });

  it('can combine month filter and limit', async () => {
    const client = mockClient([
      txRow({ id: 'march', date: '2025-03-01' }),
      txRow({ id: 'april-1', date: '2025-04-01' }),
      txRow({ id: 'april-2', date: '2025-04-10' }),
      txRow({ id: 'april-3', date: '2025-04-20' }),
    ]);
    const result = await fetchTransactions(client, { month: '2025-04', limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].transaction_id).toBe('april-3');
    expect(result[1].transaction_id).toBe('april-2');
  });
});
