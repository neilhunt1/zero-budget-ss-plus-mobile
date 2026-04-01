import { SheetsClient, colIndexToLetter } from './client';
import { Transaction, TransactionStatus, TransactionType, CategoryType } from '../types';

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
 * Append a new transaction row to the sheet.
 * `transaction_id` should be pre-populated by the caller (e.g. crypto.randomUUID()).
 */
export async function appendTransaction(
  client: SheetsClient,
  tx: Omit<Transaction, '_rowIndex'>
): Promise<void> {
  await client.appendValues('Transactions!A2', [serializeRow(tx)]);
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
 * Compute per-category activity (outflow − inflow) for a set of transactions.
 * Transfers are excluded — they have no budget impact.
 */
export function computeCategoryActivity(
  transactions: Transaction[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (!tx.category || tx.transaction_type === 'transfer') continue;
    map.set(tx.category, (map.get(tx.category) ?? 0) + tx.outflow - tx.inflow);
  }
  return map;
}
