import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must import db after fake-indexeddb/auto so Dexie uses the fake implementation.
import { db } from '../../../src/db/schema';
import { syncOnOpen, getCurrentSyncProgress } from '../../../src/db/sync';

// ─── Mock API layer ───────────────────────────────────────────────────────────

vi.mock('../../../src/api/transactions', () => ({
  fetchTransactions: vi.fn().mockResolvedValue([
    {
      transaction_id: 'tx-1',
      parent_id: '',
      split_group_id: '',
      source: 'manual',
      external_id: '',
      imported_at: '',
      status: 'cleared',
      date: '2025-04-01',
      payee: 'Supermarket',
      description: '',
      category: 'Groceries 🛒',
      suggested_category: '',
      category_subgroup: '',
      category_group: '',
      category_type: '',
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
      _rowIndex: 2,
    },
  ]),
}));

vi.mock('../../../src/api/budget', () => ({
  fetchBudgetCategories: vi.fn().mockResolvedValue([
    {
      category_group: 'Living',
      category_subgroup: 'Food',
      category: 'Groceries 🛒',
      category_type: 'fluid',
      monthly_template_amount: 0,
      sort_order: 1,
      active: true,
      _rowIndex: 7,
    },
  ]),
  fetchAllAssignments: vi.fn().mockResolvedValue([
    { month: '2025-04', category: 'Groceries 🛒', assigned: 400, source: 'manual', _rowIndex: 509 },
  ]),
  fetchAllGroupAssignments: vi.fn().mockResolvedValue([]),
  fetchAllCategoryCalcEntries: vi.fn().mockResolvedValue([
    { month: '2025-04', category: 'Groceries 🛒', activity: 50, available: 350 },
  ]),
  fetchGroupMetadata: vi.fn().mockResolvedValue([]),
  fetchReadyToAssign: vi.fn().mockResolvedValue(1234),
}));

vi.mock('../../../src/api/client', () => ({
  SheetsClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/api/bts', () => ({
  normalizeBtsTransactions: vi.fn().mockResolvedValue({ inserted: 0, updated: 0 }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resetDb() {
  await db.delete();
  await db.open();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('syncOnOpen', () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
  });

  it('cold start: populates all tables and writes syncMeta', async () => {
    await syncOnOpen('token', 'sheet-id', 'v42');

    const txns = await db.transactions.toArray();
    expect(txns).toHaveLength(1);
    expect(txns[0].transaction_id).toBe('tx-1');

    const cats = await db.budgetCategories.toArray();
    expect(cats).toHaveLength(1);
    expect(cats[0].category).toBe('Groceries 🛒');

    const assignments = await db.budgetAssignments.toArray();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].month).toBe('2025-04');

    const calcs = await db.budgetCalcs.toArray();
    expect(calcs).toHaveLength(1);
    expect(calcs[0].available).toBe(350);

    const meta = await db.syncMeta.get('all');
    expect(meta?.lastSheetVersion).toBe('v42');
    expect(meta?.rowCount).toBe(1);
  });

  it('skips sync when version already matches syncMeta', async () => {
    // Pre-populate syncMeta with the current version.
    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: '2025-04-01T00:00:00Z',
      lastSheetVersion: 'v42',
      rowCount: 1,
    });

    const { fetchTransactions } = await import('../../../src/api/transactions');
    await syncOnOpen('token', 'sheet-id', 'v42');

    expect(fetchTransactions).not.toHaveBeenCalled();
  });

  it('re-syncs when version has changed', async () => {
    // Pre-populate with an older version.
    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: '2025-04-01T00:00:00Z',
      lastSheetVersion: 'v41',
      rowCount: 0,
    });

    const { fetchTransactions } = await import('../../../src/api/transactions');
    await syncOnOpen('token', 'sheet-id', 'v42');

    expect(fetchTransactions).toHaveBeenCalledOnce();

    const meta = await db.syncMeta.get('all');
    expect(meta?.lastSheetVersion).toBe('v42');
  });

  it('emits cold-start progress event on first sync', async () => {
    const events: string[] = [];
    const { onSyncProgress } = await import('../../../src/db/sync');
    const unsub = onSyncProgress((p) => events.push(p.status));

    await syncOnOpen('token', 'sheet-id', 'v1');
    unsub();

    expect(events).toContain('cold-start');
    expect(events).toContain('complete');
  });

  it('emits syncing (not cold-start) when syncMeta already exists', async () => {
    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: '2025-04-01T00:00:00Z',
      lastSheetVersion: 'v41',
      rowCount: 0,
    });

    const events: string[] = [];
    const { onSyncProgress } = await import('../../../src/db/sync');
    const unsub = onSyncProgress((p) => events.push(p.status));

    await syncOnOpen('token', 'sheet-id', 'v42');
    unsub();

    expect(events).not.toContain('cold-start');
    expect(events).toContain('syncing');
    expect(events).toContain('complete');
  });

  it('emits error status and rethrows when fetch fails', async () => {
    const { fetchTransactions } = await import('../../../src/api/transactions');
    vi.mocked(fetchTransactions).mockRejectedValueOnce(new Error('network failure'));

    const statuses: string[] = [];
    const { onSyncProgress } = await import('../../../src/db/sync');
    const unsub = onSyncProgress((p) => statuses.push(p.status));

    await expect(syncOnOpen('token', 'sheet-id', 'v99')).rejects.toThrow('network failure');
    unsub();

    expect(statuses).toContain('error');
    // syncMeta must NOT be updated on failure
    expect(await db.syncMeta.get('all')).toBeUndefined();
  });
});

describe('getCurrentSyncProgress', () => {
  it('returns the most recent progress without subscribing', async () => {
    expect(getCurrentSyncProgress().status).toBeDefined();
  });
});
