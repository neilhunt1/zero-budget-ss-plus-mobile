import { SheetsClient } from '../api/client';
import { fetchTransactions } from '../api/transactions';
import {
  fetchBudgetCategories,
  fetchAllAssignments,
  fetchAllGroupAssignments,
  fetchAllCategoryCalcEntries,
  fetchGroupMetadata,
  fetchReadyToAssign,
} from '../api/budget';
import { normalizeBtsTransactions } from '../api/bts';
import { fetchAccounts } from '../api/accounts';
import { db } from './schema';

export interface SyncProgress {
  status: 'idle' | 'cold-start' | 'syncing' | 'complete' | 'error';
  loaded: number;
  total: number | null;
  error?: string;
}

// ─── Module-level progress event system ──────────────────────────────────────

let _listeners: Array<(p: SyncProgress) => void> = [];
let _current: SyncProgress = { status: 'idle', loaded: 0, total: null };

// Prevents concurrent syncOnOpen calls from racing each other.
// A second call while one is in flight is a no-op; the caller's
// version will be picked up on the next poll cycle.
let _syncInFlight = false;

/** Subscribe to sync progress events. Returns an unsubscribe function. */
export function onSyncProgress(cb: (p: SyncProgress) => void): () => void {
  _listeners.push(cb);
  return () => {
    _listeners = _listeners.filter((l) => l !== cb);
  };
}

export function getCurrentSyncProgress(): SyncProgress {
  return _current;
}

function notify(p: SyncProgress): void {
  _current = p;
  _listeners.forEach((l) => l(p));
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Sync Google Sheets data into IndexedDB.
 *
 * Called by useSheetSync whenever the Drive file version differs from
 * what's stored in syncMeta. On cold start (no syncMeta entry) the UI
 * shows a loading overlay; subsequent syncs are silent.
 *
 * The `sheetVersion` string is the Drive API `version` field already fetched
 * by the caller — avoids a redundant Drive API call here.
 */
export async function syncOnOpen(
  token: string,
  sheetId: string,
  sheetVersion: string
): Promise<void> {
  if (_syncInFlight) return;

  const lastSync = await db.syncMeta.get('all');

  // Already up to date — nothing to do.
  if (lastSync?.lastSheetVersion === sheetVersion) return;

  _syncInFlight = true;
  const isColdStart = !lastSync;
  notify({ status: isColdStart ? 'cold-start' : 'syncing', loaded: 0, total: null });

  try {
    const client = new SheetsClient(sheetId, token);

    // Normalize new BTS rows into Transactions tab before fetching,
    // so the fetch below picks them up in the same sync cycle.
    // Non-fatal: a BTS write failure should not prevent the data reads that follow.
    try {
      await normalizeBtsTransactions(client);
    } catch (e) {
      console.warn('[sync] BTS normalization failed — skipping, data reads will continue:', e);
    }

    // Fetch all transactions (including split children for complete cache)
    const transactions = await fetchTransactions(client, { includeSplitChildren: true });

    // Remove orphaned IndexedDB records that no longer exist in the sheet.
    // This cleans up split children that were written optimistically to IndexedDB
    // but never persisted to Sheets (e.g. due to the OVERWRITE silent-no-op bug).
    const sheetIds = new Set(transactions.map((t) => t.transaction_id));
    const localIds = (await db.transactions.toCollection().primaryKeys()) as string[];
    const orphanIds = localIds.filter((id) => !sheetIds.has(id));
    if (orphanIds.length > 0) {
      console.log(`[sync] Purging ${orphanIds.length} orphaned transaction(s) from IndexedDB`);
      await db.transactions.bulkDelete(orphanIds);
    }

    await db.transactions.bulkPut(transactions);
    notify({
      status: isColdStart ? 'cold-start' : 'syncing',
      loaded: transactions.length,
      total: transactions.length,
    });

    // Budget categories (including inactive — faithful copy of sheet)
    const categories = await fetchBudgetCategories(client, { activeOnly: false });
    await db.budgetCategories.bulkPut(categories);

    // All assignments across all months
    const assignments = await fetchAllAssignments(client);
    await db.budgetAssignments.bulkPut(assignments);

    // Pre-computed budget calcs (activity + available per month/category)
    const calcs = await fetchAllCategoryCalcEntries(client);
    await db.budgetCalcs.bulkPut(calcs);

    // Group metadata (budget_type, rollover settings)
    const groups = await fetchGroupMetadata(client);
    await db.budgetGroups.bulkPut(groups);

    // Group-level budget assignments (rows with blank category in assignments table)
    const groupAssignments = await fetchAllGroupAssignments(client);
    await db.budgetGroupAssignments.bulkPut(groupAssignments);

    // Accounts and aliases (non-fatal — tab may not exist yet on old sheets)
    try {
      const { accounts, aliases } = await fetchAccounts(client);
      await db.accounts.clear();
      await db.accounts.bulkPut(accounts);
      await db.accountAliases.clear();
      await db.accountAliases.bulkPut(aliases);
    } catch (e) {
      console.warn('[sync] Accounts tab fetch failed — skipping (tab may not exist yet):', e);
    }

    const readyToAssign = await fetchReadyToAssign(client);

    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: new Date().toISOString(),
      lastSheetVersion: sheetVersion,
      rowCount: transactions.length,
      readyToAssign,
      lastBtsSyncedAt: new Date().toISOString(),
    });

    notify({ status: 'complete', loaded: transactions.length, total: transactions.length });
  } catch (e) {
    notify({ status: 'error', loaded: 0, total: null, error: String(e) });
    throw e;
  } finally {
    _syncInFlight = false;
  }
}

/**
 * Re-fetch budget assignments, calcs, and readyToAssign after a write operation,
 * then push the updates into IndexedDB so useLiveQuery subscribers re-render.
 *
 * Does NOT re-sync transactions — call syncOnOpen for a full sync.
 */
export async function refreshMonthBudget(token: string, sheetId: string): Promise<void> {
  const client = new SheetsClient(sheetId, token);
  const [assignments, groupAssignments, calcs, readyToAssign] = await Promise.all([
    fetchAllAssignments(client),
    fetchAllGroupAssignments(client),
    fetchAllCategoryCalcEntries(client),
    fetchReadyToAssign(client),
  ]);
  await db.budgetAssignments.bulkPut(assignments);
  await db.budgetGroupAssignments.bulkPut(groupAssignments);
  await db.budgetCalcs.bulkPut(calcs);
  const lastSync = await db.syncMeta.get('all');
  if (lastSync) {
    await db.syncMeta.put({ ...lastSync, readyToAssign });
  }
}
