import { SheetsClient } from '../api/client';
import { fetchTransactions } from '../api/transactions';
import {
  fetchBudgetCategories,
  fetchAllAssignments,
  fetchAllCategoryCalcEntries,
  fetchReadyToAssign,
} from '../api/budget';
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
  const lastSync = await db.syncMeta.get('all');

  // Already up to date — nothing to do.
  if (lastSync?.lastSheetVersion === sheetVersion) return;

  const isColdStart = !lastSync;
  notify({ status: isColdStart ? 'cold-start' : 'syncing', loaded: 0, total: null });

  try {
    const client = new SheetsClient(sheetId, token);

    // Fetch all transactions (including split children for complete cache)
    const transactions = await fetchTransactions(client, { includeSplitChildren: true });
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

    const readyToAssign = await fetchReadyToAssign(client);

    await db.syncMeta.put({
      key: 'all',
      lastSyncedAt: new Date().toISOString(),
      lastSheetVersion: sheetVersion,
      rowCount: transactions.length,
      readyToAssign,
    });

    notify({ status: 'complete', loaded: transactions.length, total: transactions.length });
  } catch (e) {
    notify({ status: 'error', loaded: 0, total: null, error: String(e) });
    throw e;
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
  const [assignments, calcs, readyToAssign] = await Promise.all([
    fetchAllAssignments(client),
    fetchAllCategoryCalcEntries(client),
    fetchReadyToAssign(client),
  ]);
  await db.budgetAssignments.bulkPut(assignments);
  await db.budgetCalcs.bulkPut(calcs);
  const lastSync = await db.syncMeta.get('all');
  if (lastSync) {
    await db.syncMeta.put({ ...lastSync, readyToAssign });
  }
}
