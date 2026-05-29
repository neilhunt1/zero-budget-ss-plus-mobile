import { SheetsClient, colIndexToLetter } from './client';
import { Transaction, TransactionStatus, TransactionType, CategoryType } from '../types';
import { getAccountType } from '../utils/accountNames';

// Column order must match scripts/setup-sheet.ts TRANSACTIONS_COLUMNS exactly.
const COLS = [
  'transaction_id',     // A
  'parent_id',          // B
  'split_group_id',     // C
  'source',             // D
  'external_id',        // E
  'imported_at',        // F
  'status',             // G
  'date',               // H
  'payee',              // I
  'description',        // J
  'category',           // K
  'suggested_category', // L
  'category_subgroup',  // M
  'category_group',     // N
  'category_type',      // O
  'outflow',            // P
  'inflow',             // Q
  'account',            // R
  'memo',               // S
  'transaction_type',   // T
  'transfer_pair_id',   // U
  'flag',               // V
  'needs_reimbursement',// W
  'reimbursement_amount',// X
  'matched_id',         // Y
  'reviewed',           // Z
] as const;

function colIdx(name: (typeof COLS)[number]): number {
  return COLS.indexOf(name);
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parseRow(row: string[], rowIndex: number): Transaction {
  const c = (name: (typeof COLS)[number]) => row[colIdx(name)] ?? '';
  return {
    transaction_id: c('transaction_id'),
    parent_id: c('parent_id'),
    split_group_id: c('split_group_id'),
    source: c('source'),
    external_id: c('external_id'),
    imported_at: c('imported_at'),
    status: c('status') as TransactionStatus,
    date: c('date'),
    payee: c('payee'),
    description: c('description'),
    category: c('category'),
    suggested_category: c('suggested_category'),
    category_subgroup: c('category_subgroup'),
    category_group: c('category_group'),
    category_type: c('category_type') as CategoryType | '',
    outflow: parseFloat(c('outflow')) || 0,
    inflow: parseFloat(c('inflow')) || 0,
    account: c('account'),
    memo: c('memo'),
    transaction_type: c('transaction_type') as TransactionType | '',
    transfer_pair_id: c('transfer_pair_id'),
    flag: c('flag'),
    needs_reimbursement: c('needs_reimbursement').toUpperCase() === 'TRUE',
    reimbursement_amount: parseFloat(c('reimbursement_amount')) || 0,
    matched_id: c('matched_id'),
    reviewed: c('reviewed').toUpperCase() === 'TRUE',
    _rowIndex: rowIndex,
  };
}

function serializeRow(tx: Omit<Transaction, '_rowIndex'>): unknown[] {
  return COLS.map((col) => {
    const val = (tx as Record<string, unknown>)[col];
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val ?? '';
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FetchTransactionsOptions {
  /** Filter to transactions whose date starts with this prefix (e.g. "2025-03"). */
  month?: string;
  /** Include child split rows (parent_id set). Default: false. */
  includeSplitChildren?: boolean;
  /** Return at most this many transactions (newest first after filtering). */
  limit?: number;
}

/**
 * Fetch transactions from the sheet.
 * Returns rows newest-first.
 */
export async function fetchTransactions(
  client: SheetsClient,
  opts: FetchTransactionsOptions = {}
): Promise<Transaction[]> {
  const res = await client.getValues('Transactions!A2:Z');
  const rows = res.values ?? [];

  let transactions = rows.map((row, i) => parseRow(row, i + 2));

  // Strip completely empty rows (no transaction_id)
  transactions = transactions.filter((t) => t.transaction_id);

  if (!opts.includeSplitChildren) {
    transactions = transactions.filter((t) => !t.parent_id);
  }

  if (opts.month) {
    transactions = transactions.filter((t) => t.date.startsWith(opts.month!));
  }

  // Sort newest-first
  transactions.sort((a, b) => b.date.localeCompare(a.date));

  if (opts.limit) {
    transactions = transactions.slice(0, opts.limit);
  }

  return transactions;
}

/**
 * Find the next empty row in the Transactions sheet by counting occupied rows
 * in column A (which always has transaction_id set). Row 1 is the header, so
 * data rows occupy A2:A{N}. Returns N+1 — the first empty row.
 *
 * This is used by append functions instead of the Sheets :append endpoint,
 * because that endpoint's table-detection (tableRange) returns undefined on
 * large sheets and silently falls back to the anchor cell, writing data at
 * the wrong position (top of sheet instead of bottom).
 */
async function nextTransactionRow(client: SheetsClient): Promise<number> {
  const result = await client.getValues('Transactions!A:A');
  // values.length counts every row from A1 (header) through the last non-empty
  // cell. Adding 1 gives the first empty row after all existing data.
  return (result.values?.length ?? 1) + 1;
}

/**
 * Append a new transaction row to the sheet.
 * `transaction_id` should be pre-populated by the caller (e.g. crypto.randomUUID()).
 */
export async function appendTransaction(
  client: SheetsClient,
  tx: Omit<Transaction, '_rowIndex'>
): Promise<void> {
  const row = await nextTransactionRow(client);
  // Anchor to the last data row and INSERT_ROWS so the sheet auto-extends even
  // when row `row` hasn't been allocated yet. values.update (PUT) requires the
  // target row to already exist, which fails with 400 when the sheet is exactly
  // at its row-count boundary. Anchoring to the last *data* row (not A1) avoids
  // the table-detection unreliability seen with :append on large sheets.
  const anchor = `Transactions!A${row - 1}`;
  if (import.meta.env.DEV) console.log(`[appendTransaction] → after row ${row - 1} (anchor ${anchor})`);
  await client.appendValues(anchor, [serializeRow(tx)], 'INSERT_ROWS');
}

/**
 * Append multiple transaction rows in a single call.
 * Prefer this over calling appendTransaction() in a loop to avoid rate limits.
 */
export async function appendTransactions(
  client: SheetsClient,
  txns: Omit<Transaction, '_rowIndex'>[],
): Promise<void> {
  if (txns.length === 0) return;
  const row = await nextTransactionRow(client);
  // See appendTransaction() for why INSERT_ROWS anchored to the last data row
  // is used instead of values.update (PUT).
  const anchor = `Transactions!A${row - 1}`;
  if (import.meta.env.DEV) console.log(`[appendTransactions] ${txns.length} row(s) → after row ${row - 1}`);
  await client.appendValues(anchor, txns.map(serializeRow), 'INSERT_ROWS');
}

/**
 * Update specific fields of an existing transaction in-place.
 * Uses individual cell writes to avoid overwriting unrelated columns.
 */
export async function updateTransactionFields(
  client: SheetsClient,
  rowIndex: number,
  fields: Partial<Omit<Transaction, '_rowIndex'>>
): Promise<void> {
  for (const [key, value] of Object.entries(fields)) {
    const idx = COLS.indexOf(key as (typeof COLS)[number]);
    if (idx === -1) continue; // ignore unknown keys
    const letter = colIndexToLetter(idx);
    const cellValue = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value ?? '');
    await client.updateValues(`Transactions!${letter}${rowIndex}`, [[cellValue]]);
  }
}

/**
 * Derive the semantic transaction type from a transaction's fields.
 * Handles both new-style values ('income'|'transfer'|'credit_payment'|'regular')
 * and legacy values ('debit'|'credit') that may exist in older sheet data.
 */
export function classifyTransactionType(tx: Transaction): TransactionType | '' {
  if (['income', 'transfer', 'credit_payment', 'regular'].includes(tx.transaction_type)) {
    return tx.transaction_type as TransactionType;
  }
  // Legacy mappings
  if ((tx.transaction_type as string) === 'debit') return 'regular';
  if ((tx.transaction_type as string) === 'credit') {
    return tx.inflow > 0 && !tx.category ? 'income' : 'regular';
  }
  // Blank — infer from structural signals only (avoid false income classification)
  if (tx.transfer_pair_id) return 'transfer';
  if (tx.outflow > 0 || (tx.inflow > 0 && tx.category)) return 'regular';
  // Uncategorized inflow with no pair — leave unclassified so triage handles it
  return '';
}

/**
 * Scan a list of transactions for a matching transfer pair.
 * Looks for a different-account transaction within ±7 days with the same amount (±$0.01).
 */
export function findTransferPair(
  tx: Transaction,
  allTxns: Transaction[]
): Transaction | null {
  const amount = tx.outflow || tx.inflow;
  const txTime = new Date(tx.date).getTime();
  return (
    allTxns.find((other) => {
      if (other.transaction_id === tx.transaction_id || other.account === tx.account) return false;
      const otherAmount = other.outflow || other.inflow;
      if (Math.abs(otherAmount - amount) > 0.01) return false;
      const daysDiff = Math.abs(new Date(other.date).getTime() - txTime) / 86_400_000;
      return daysDiff <= 7;
    }) ?? null
  );
}

/**
 * Scan a list of transactions for a matching CC payment leg.
 * Requires one account to be a credit card and the other depository, within ±7 days, ±$0.01.
 * Window matches findTransferPair — CC payments can post to the two accounts several days apart.
 */
export function findCcPaymentPair(
  tx: Transaction,
  allTxns: Transaction[]
): Transaction | null {
  const txType = getAccountType(tx.account);
  const amount = tx.outflow || tx.inflow;
  const txTime = new Date(tx.date).getTime();
  return (
    allTxns.find((other) => {
      if (other.transaction_id === tx.transaction_id || other.account === tx.account) return false;
      const otherType = getAccountType(other.account);
      // Must be credit ↔ depository
      if (!((txType === 'credit' && otherType === 'depository') ||
            (txType === 'depository' && otherType === 'credit'))) return false;
      const otherAmount = other.outflow || other.inflow;
      if (Math.abs(otherAmount - amount) > 0.01) return false;
      const daysDiff = Math.abs(new Date(other.date).getTime() - txTime) / 86_400_000;
      return daysDiff <= 7;
    }) ?? null
  );
}

/**
 * Compute per-category activity (outflow − inflow) for a set of transactions.
 * Transfers and income are excluded — they have no budget category impact.
 */
export function computeCategoryActivity(
  transactions: Transaction[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (!tx.category || tx.transaction_type === 'transfer' || tx.transaction_type === 'credit_payment' || tx.transaction_type === 'income') continue;
    map.set(tx.category, (map.get(tx.category) ?? 0) + tx.outflow - tx.inflow);
  }
  return map;
}
