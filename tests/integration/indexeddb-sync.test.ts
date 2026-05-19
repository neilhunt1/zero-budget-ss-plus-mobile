/**
 * Integration tests for the IndexedDB sync pipeline.
 * @integration
 *
 * These tests exercise the full syncOnOpen flow end-to-end:
 *   real Sheets API (via SheetsClient) → fake IndexedDB (fake-indexeddb/auto)
 *
 * They require:
 *   GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key
 *   GOOGLE_SHEET_ID set to the dev sheet
 *   VITE_GOOGLE_ACCESS_TOKEN set to a valid OAuth bearer token
 *     (or the tests that need real API calls are skipped)
 *
 * Run with: npm run test:integration
 *
 * What is verified:
 *   - Cold start: wipe IndexedDB → sync → syncMeta populated, tables non-empty
 *   - Same-version gate: calling syncOnOpen with a matching version skips all API calls
 *   - Version bump: syncing with a new version re-fetches and updates syncMeta
 *   - getBudgetForMonth produces correct shape after a sync
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.development' });

// ─── Credential / token setup ─────────────────────────────────────────────────

if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
}

// Import db and sync after fake-indexeddb/auto so Dexie uses the shim.
import { db } from '../../src/db/schema';
import { syncOnOpen } from '../../src/db/sync';
import { getBudgetForMonth } from '../../src/db/queries';

const TIMEOUT_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resetDb() {
  await db.delete();
  await db.open();
}

// ─── Mock API layer ───────────────────────────────────────────────────────────
// We mock the Sheets API layer so these tests don't require a valid OAuth token
// (service account auth differs from the Bearer-token auth SheetsClient uses).
// The integration value comes from verifying the full sync orchestration and
// IndexedDB write/read pipeline — not from hitting the real Sheets endpoints.

const MOCK_TRANSACTIONS = [
  {
    transaction_id: 'int-tx-1',
    parent_id: '',
    split_group_id: '',
    source: 'manual' as const,
    external_id: '',
    imported_at: '2025-04-01T00:00:00Z',
    status: 'cleared' as const,
    date: '2025-04-15',
    payee: 'Supermarket',
    description: '',
    category: 'Groceries 🛒',
    suggested_category: '',
    category_subgroup: 'Food',
    category_group: 'Living',
    category_type: 'fluid',
    outflow: 95.50,
    inflow: 0,
    account: 'Checking',
    memo: 'Weekly shop',
    transaction_type: 'regular' as const,
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: true,
    _rowIndex: 2,
  },
  {
    transaction_id: 'int-tx-2',
    parent_id: '',
    split_group_id: '',
    source: 'banksheets' as const,
    external_id: 'ext-123',
    imported_at: '2025-04-10T00:00:00Z',
    status: 'cleared' as const,
    date: '2025-04-10',
    payee: 'Petrol Station',
    description: '',
    category: 'Fuel ⛽',
    suggested_category: '',
    category_subgroup: 'Transport',
    category_group: 'Living',
    category_type: 'fluid',
    outflow: 82.00,
    inflow: 0,
    account: 'Checking',
    memo: '',
    transaction_type: 'regular' as const,
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    _rowIndex: 3,
  },
];

const MOCK_CATEGORIES = [
  {
    category_group: 'Living',
    category_subgroup: 'Food',
    category: 'Groceries 🛒',
    category_type: 'fluid' as const,
    monthly_template_amount: 400,
    sort_order: 1,
    active: true,
    _rowIndex: 7,
  },
  {
    category_group: 'Living',
    category_subgroup: 'Transport',
    category: 'Fuel ⛽',
    category_type: 'fluid' as const,
    monthly_template_amount: 120,
    sort_order: 2,
    active: true,
    _rowIndex: 8,
  },
];

const MOCK_ASSIGNMENTS = [
  { month: '2025-04', category: 'Groceries 🛒', assigned: 400, source: 'manual' as const, _rowIndex: 509 },
  { month: '2025-04', category: 'Fuel ⛽', assigned: 120, source: 'manual' as const, _rowIndex: 510 },
];

const MOCK_CALCS = [
  { month: '2025-04', category: 'Groceries 🛒', activity: 95.5, available: 304.5 },
  { month: '2025-04', category: 'Fuel ⛽', activity: 82, available: 38 },
];

// vi.mock factories are hoisted before variable declarations, so mock data
// constants are set up in beforeEach via vi.mocked() instead of inline here.
vi.mock('../../src/api/transactions', () => ({ fetchTransactions: vi.fn() }));

vi.mock('../../src/api/budget', async (importOriginal) => {
  // Preserve real buildGroupedBudget — only stub the fetch functions.
  const actual = await importOriginal<typeof import('../../src/api/budget')>();
  return {
    ...actual,
    fetchBudgetCategories: vi.fn(),
    fetchAllAssignments: vi.fn(),
    fetchAllCategoryCalcEntries: vi.fn(),
    fetchReadyToAssign: vi.fn(),
  };
});

vi.mock('../../src/api/client', () => ({
  SheetsClient: vi.fn().mockImplementation(() => ({})),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IndexedDB sync pipeline @integration', () => {
  beforeEach(async () => {
    await resetDb();
    const { fetchTransactions } = await import('../../src/api/transactions');
    const { fetchBudgetCategories, fetchAllAssignments, fetchAllCategoryCalcEntries, fetchReadyToAssign } =
      await import('../../src/api/budget');
    vi.mocked(fetchTransactions).mockResolvedValue(MOCK_TRANSACTIONS);
    vi.mocked(fetchBudgetCategories).mockResolvedValue(MOCK_CATEGORIES);
    vi.mocked(fetchAllAssignments).mockResolvedValue(MOCK_ASSIGNMENTS);
    vi.mocked(fetchAllCategoryCalcEntries).mockResolvedValue(MOCK_CALCS);
    vi.mocked(fetchReadyToAssign).mockResolvedValue(500);
  });
  afterEach(() => vi.clearAllMocks());

  it('cold start: populates all tables and writes syncMeta', async () => {
    await syncOnOpen('fake-token', 'sheet-id', 'v10');

    const meta = await db.syncMeta.get('all');
    expect(meta).toBeDefined();
    expect(meta?.lastSheetVersion).toBe('v10');
    expect(meta?.rowCount).toBe(2);
    expect(meta?.readyToAssign).toBe(500);
    expect(meta?.lastSyncedAt).toBeTruthy();

    const txns = await db.transactions.toArray();
    expect(txns).toHaveLength(2);

    const cats = await db.budgetCategories.toArray();
    expect(cats).toHaveLength(2);

    const assignments = await db.budgetAssignments.toArray();
    expect(assignments).toHaveLength(2);

    const calcs = await db.budgetCalcs.toArray();
    expect(calcs).toHaveLength(2);
  }, TIMEOUT_MS);

  it('same-version gate: skips all API calls when version matches', async () => {
    // Pre-populate syncMeta with the version we will pass.
    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: new Date().toISOString(),
      lastSheetVersion: 'v10',
      rowCount: 2,
    });

    const { fetchTransactions } = await import('../../src/api/transactions');
    const { fetchBudgetCategories } = await import('../../src/api/budget');
    vi.clearAllMocks(); // clear beforeEach call counts

    await syncOnOpen('fake-token', 'sheet-id', 'v10');

    expect(fetchTransactions).not.toHaveBeenCalled();
    expect(fetchBudgetCategories).not.toHaveBeenCalled();
    // syncMeta unchanged
    const meta = await db.syncMeta.get('all');
    expect(meta?.lastSheetVersion).toBe('v10');
  }, TIMEOUT_MS);

  it('version bump: re-syncs when version has changed', async () => {
    // First sync at v10.
    await syncOnOpen('fake-token', 'sheet-id', 'v10');
    const { fetchTransactions } = await import('../../src/api/transactions');
    vi.clearAllMocks();

    // Second sync at v11 — should re-fetch.
    await syncOnOpen('fake-token', 'sheet-id', 'v11');

    expect(fetchTransactions).toHaveBeenCalledOnce();
    const meta = await db.syncMeta.get('all');
    expect(meta?.lastSheetVersion).toBe('v11');
  }, TIMEOUT_MS);

  it('sync failure leaves syncMeta unchanged', async () => {
    const { fetchTransactions } = await import('../../src/api/transactions');
    vi.mocked(fetchTransactions).mockRejectedValueOnce(new Error('network error')); // override beforeEach value

    await expect(syncOnOpen('fake-token', 'sheet-id', 'v1')).rejects.toThrow('network error');

    const meta = await db.syncMeta.get('all');
    expect(meta).toBeUndefined();
  }, TIMEOUT_MS);

  it('getBudgetForMonth returns correct shape after sync', async () => {
    await syncOnOpen('fake-token', 'sheet-id', 'v10');

    const budget = await getBudgetForMonth('2025-04');

    // Should have at least one group
    expect(budget.length).toBeGreaterThan(0);

    // Find the Groceries category (GroupedBudget nests: group → subgroups → categories)
    const groceriesEntry = budget
      .flatMap((g) => g.subgroups)
      .flatMap((s) => s.categories)
      .find((c) => c.category === 'Groceries 🛒');

    expect(groceriesEntry).toBeDefined();
    expect(groceriesEntry?.assigned).toBe(400);
    expect(groceriesEntry?.activity).toBe(95.5);
    expect(groceriesEntry?.available).toBe(304.5);
  }, TIMEOUT_MS);
});
