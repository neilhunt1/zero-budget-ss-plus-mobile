import { SheetsClient } from './client';
import { Transaction } from '../types';
import { appendTransaction, updateTransactionFields } from './transactions';

const BTS_TAB = 'Transactions (BTS)';
const TRANSACTIONS_EXT_ID_RANGE = 'Transactions!E2:G'; // external_id(E), status(G)

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
  // Read BTS source tab (header row + data rows)
  const btsRes = await client.getValues(`${BTS_TAB}!A1:Z`);
  const btsAllRows = btsRes.values ?? [];
  if (btsAllRows.length < 2) return { inserted: 0, updated: 0 };

  // Build header → column index map (BTS controls schema, not positional)
  const headers = btsAllRows[0].map((h) => h.trim());
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

  if (idxId === -1 || idxDate === -1) return { inserted: 0, updated: 0 };

  const btsRows = btsAllRows.slice(1);

  // Read existing external_ids + status from Transactions tab for dedup
  // Columns: E=external_id, F=imported_at, G=status — we read E:G
  const extRes = await client.getValues(TRANSACTIONS_EXT_ID_RANGE);
  const extRows = extRes.values ?? [];

  // Map: external_id → { rowIndex (1-based sheet row), status }
  const existing = new Map<string, { rowIndex: number; status: string }>();
  for (let i = 0; i < extRows.length; i++) {
    const externalId = extRows[i][0]?.trim();
    if (!externalId) continue;
    const status = extRows[i][2]?.trim() ?? '';
    existing.set(externalId, { rowIndex: i + 2, status }); // +2: 1-based + header row
  }

  let inserted = 0;
  let updated = 0;

  for (const row of btsRows) {
    const transactionId = row[idxId]?.trim();
    if (!transactionId) continue;

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

    // New row — normalize and append
    const tx = normalizeBtsRow(btsRow);
    await appendTransaction(client, tx);
    inserted++;
  }

  return { inserted, updated };
}
