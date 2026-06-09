import { SheetsClient } from './client';
import { Transaction } from '../types';
import { appendTransactions, updateTransactionFields } from './transactions';

const BTS_TAB = 'Transactions (BTS)';
const TRANSACTIONS_EXT_ID_RANGE = 'Transactions!E2:G'; // external_id(E), status(G)
const CONFIG_TAB = 'Config';

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Parse BTS date format 'MM/DD/YYYY' → 'YYYY-MM-DD'. */
export function parseBtsDate(s: string): string {
  const [m, d, y] = s.trim().split('/');
  if (!m || !d || !y) return s;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Parse BTS amount format '$ 25.00' → 25.00. */
export function parseBtsAmount(s: string): number {
  return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
}

/** Use Merchant as payee, fall back to Description. */
export function selectBtsPayee(merchant: string, description: string): string {
  return merchant?.trim() || description?.trim() || 'Unknown';
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface BtsRow {
  Transaction_id: string;
  Date: string;
  pending: string;
  Description: string;
  Merchant: string;
  Outflow: string;
  Inflow: string;
  Auto_Category: string;
  Account: string;
  Memo: string;
}

/** Map a parsed BTS row to the Transaction schema. */
export function normalizeBtsRow(row: BtsRow): Omit<Transaction, '_rowIndex'> {
  return {
    transaction_id: 'BTS-' + row.Transaction_id,
    external_id: row.Transaction_id,
    source: 'banksheets',
    status: row.pending.toUpperCase() === 'TRUE' ? 'pending' : 'cleared',
    date: parseBtsDate(row.Date),
    payee: selectBtsPayee(row.Merchant, row.Description),
    description: row.Description?.trim() ?? '',
    outflow: parseBtsAmount(row.Outflow),
    inflow: parseBtsAmount(row.Inflow),
    suggested_category: row.Auto_Category?.trim() ?? '',
    account: row.Account?.trim() ?? '',
    memo: row.Memo?.trim() ?? '',
    imported_at: new Date().toISOString(),
    transaction_type: 'regular',
    category: '',
    reviewed: false,
    parent_id: '',
    split_group_id: '',
    transfer_pair_id: '',
    flag: '',
    matched_id: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    category_subgroup: '',
    category_group: '',
    category_type: '',
  };
}

// ─── Main normalization function ──────────────────────────────────────────────

// ─── Main normalization function ──────────────────────────────────────────────

/**
 * Read live_sync_from_date from the Config tab.
 * Returns null if the Config tab doesn't exist or the key isn't set,
 * meaning all BTS transactions are eligible for import.
 */
async function readLiveSyncFromDate(client: SheetsClient): Promise<string | null> {
  // This must NOT silently swallow errors — if the Config tab exists and is
  // readable but the key is missing, that's fine (null = no cutover yet).
  // But if the read fails entirely, we must NOT return null and accidentally
  // let BTS re-insert all historical rows. Let the error propagate so the
  // caller can decide (normalizeBtsTransactions logs and skips on failure).
  const res = await client.getValues(`${CONFIG_TAB}!A2:B`);
  for (const row of res.values ?? []) {
    if (row[0]?.trim() === 'live_sync_from_date') {
      const val = row[1]?.trim();
      return val || null;
    }
  }
  return null;
}

/**
 * Read Transactions (BTS), normalize each row, and write new/updated rows to
 * the canonical Transactions tab.
 *
 * Deduplication is based on external_id (BTS Transaction_id). Idempotent —
 * safe to run multiple times. Also handles pending → cleared transitions.
 */
export async function normalizeBtsTransactions(
  client: SheetsClient
): Promise<{ inserted: number; updated: number }> {
  // Read live_sync_from_date from Config — BTS rows before this date are skipped.
  // This is the cutover boundary written by the import-ynab-transactions script.
  // If the Config tab is unreadable, we bail rather than inserting everything —
  // a null cutover would flood the sheet with pre-cutover BTS history.
  let liveSyncFromDate: string | null;
  try {
    liveSyncFromDate = await readLiveSyncFromDate(client);
  } catch (e) {
    console.warn('[BTS] Could not read live_sync_from_date from Config tab — skipping BTS normalization to avoid inserting pre-cutover rows:', e);
    return { inserted: 0, updated: 0 };
  }
  if (liveSyncFromDate) {
    console.log(`[BTS] live_sync_from_date: ${liveSyncFromDate} — skipping rows before this date`);
  } else {
    console.log('[BTS] live_sync_from_date not set — no YNAB import has run yet, all BTS rows eligible');
  }

  // Read BTS source tab (header row + data rows).
  let btsRes: { values?: string[][] };
  try {
    btsRes = await client.getValues(`${BTS_TAB}!A1:Z`);
  } catch (e) {
    console.warn('[BTS] Could not read BTS tab — skipping normalization:', e);
    return { inserted: 0, updated: 0 };
  }
  const btsAllRows = btsRes.values ?? [];
  console.log('[BTS] rows from sheet (incl header):', btsAllRows.length);
  if (btsAllRows.length < 2) {
    console.log('[BTS] no data rows — skipping');
    return { inserted: 0, updated: 0 };
  }

  // Build header → column index map (BTS controls schema, not positional)
  const headers = btsAllRows[0].map((h) => h.trim());
  console.log('[BTS] headers:', headers);
  const col = (name: string) => headers.indexOf(name);

  const idxId = col('Transaction_id');
  const idxDate = col('Date');
  const idxPending = col('pending');
  const idxDesc = col('Description');
  const idxMerchant = col('Merchant');
  const idxOutflow = col('Outflow');
  const idxInflow = col('Inflow');
  const idxAutoCat = col('Auto Category');
  const idxAccount = col('Account');
  const idxMemo = col('Memo');

  console.log('[BTS] column indices — Transaction_id:', idxId, 'Date:', idxDate, 'pending:', idxPending);

  if (idxId === -1 || idxDate === -1) {
    console.warn('[BTS] required columns not found — check header names in Transactions (BTS) tab');
    return { inserted: 0, updated: 0 };
  }

  const btsRows = btsAllRows.slice(1);

  // Read existing external_ids + status from Transactions tab for dedup
  // Columns: E=external_id, F=imported_at, G=status — we read E:G
  const extRes = await client.getValues(TRANSACTIONS_EXT_ID_RANGE);
  const extRows = extRes.values ?? [];
  console.log('[BTS] existing Transactions rows with external_id:', extRows.filter(r => r[0]?.trim()).length);

  // Map: external_id → { rowIndex (1-based sheet row), status }
  const existing = new Map<string, { rowIndex: number; status: string }>();
  for (let i = 0; i < extRows.length; i++) {
    const externalId = extRows[i][0]?.trim();
    if (!externalId) continue;
    const status = extRows[i][2]?.trim() ?? '';
    existing.set(externalId, { rowIndex: i + 2, status }); // +2: 1-based + header row
  }

  let updated = 0;
  const toInsert: Omit<Transaction, '_rowIndex'>[] = [];

  let skippedBeforeCutover = 0;

  for (const row of btsRows) {
    const transactionId = row[idxId]?.trim();
    if (!transactionId) continue;

    // Skip rows before the live_sync_from_date cutover boundary
    if (liveSyncFromDate) {
      const parsedDate = parseBtsDate(row[idxDate] ?? '');
      if (parsedDate < liveSyncFromDate) {
        skippedBeforeCutover++;
        continue;
      }
    }

    const isPending = row[idxPending]?.trim().toUpperCase() === 'TRUE';
    const btsRow: BtsRow = {
      Transaction_id: transactionId,
      Date: row[idxDate] ?? '',
      pending: row[idxPending] ?? '',
      Description: row[idxDesc] ?? '',
      Merchant: idxMerchant !== -1 ? (row[idxMerchant] ?? '') : '',
      Outflow: idxOutflow !== -1 ? (row[idxOutflow] ?? '') : '',
      Inflow: idxInflow !== -1 ? (row[idxInflow] ?? '') : '',
      Auto_Category: idxAutoCat !== -1 ? (row[idxAutoCat] ?? '') : '',
      Account: idxAccount !== -1 ? (row[idxAccount] ?? '') : '',
      Memo: idxMemo !== -1 ? (row[idxMemo] ?? '') : '',
    };

    const match = existing.get(transactionId);

    if (match) {
      // Pending → cleared transition
      if (match.status === 'pending' && !isPending) {
        await updateTransactionFields(client, match.rowIndex, { status: 'cleared' });
        updated++;
      }
      continue;
    }

    toInsert.push(normalizeBtsRow(btsRow));
  }

  // Single batch insert — one API call, one Drive version bump
  await appendTransactions(client, toInsert);
  const inserted = toInsert.length;

  console.log(`[BTS] done — inserted: ${inserted}, updated: ${updated}, skipped before cutover: ${skippedBeforeCutover}, skipped (already exists): ${btsRows.length - inserted - updated - skippedBeforeCutover}`);
  return { inserted, updated };
}
