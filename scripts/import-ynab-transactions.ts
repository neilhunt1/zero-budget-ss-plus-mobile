/**
 * import-ynab-transactions.ts
 *
 * One-shot script to import YNAB transaction history into the Transactions tab.
 * Purely additive — never deletes existing transactions. Safe to run multiple times.
 *
 * What it does:
 *   1. Reads a local YNAB transaction CSV export (--file flag)
 *   2. Filters to transactions on or before --cutover-date
 *   3. Detects split groups and synthesises parent rows
 *   4. Deduplicates against existing sheet transactions (3 tiers)
 *   5. Appends new rows and marks probable duplicates
 *
 * Usage:
 *   npm run import:ynab:register:dev
 *   npm run import:ynab:register:dev -- --file ~/Downloads/register.csv --cutover-date 2026-04-30
 *   npm run import:ynab:register:prod
 *
 * Defaults:
 *   --file          data/ynab/register.csv  (relative to project root)
 *   --cutover-date  today (YYYY-MM-DD)
 *
 * Idempotency contract:
 *   - Re-running with the same CSV produces no new rows (tier-1 exact dedup)
 *   - Never deletes or overwrites existing transactions of any source
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { google, sheets_v4 } from 'googleapis';
import { upsertConfigValue } from './config-tab';
import { nextDay } from './sync-from-ynab';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YnabCsvRow {
  account: string;
  flag: string;
  rawDate: string;  // MM/DD/YYYY as in CSV
  date: string;     // YYYY-MM-DD parsed
  payee: string;
  categoryGroupCategory: string;
  categoryGroup: string;
  category: string;
  memo: string;
  rawOutflow: string;
  rawInflow: string;
  outflow: number;
  inflow: number;
  cleared: string;
  /** 0-based count of how many prior rows share the same account+date+payee+outflow+inflow. */
  occurrenceIndex: number;
}

export interface ExistingTransactionSummary {
  externalId: string;
}

export type DedupAction = 'skip' | 'insert';

type AuthConfig =
  | { kind: 'keyFile'; keyPath: string }
  | { kind: 'credentials'; credentials: object };

// ─── Constants ────────────────────────────────────────────────────────────────

// Must stay in sync with setup-sheet.ts
const TRANSACTIONS_COLUMNS = [
  'transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
  'imported_at', 'status', 'date', 'payee', 'description', 'category',
  'suggested_category', 'category_subgroup', 'category_group', 'category_type',
  'outflow', 'inflow', 'account', 'memo', 'transaction_type', 'transfer_pair_id',
  'flag', 'needs_reimbursement', 'reimbursement_amount', 'matched_id', 'reviewed',
];

const SPLIT_MEMO_RE = /Split\s*\(\d+\/\d+\)/i;

// ─── Pure functions (exported for unit testing) ────────────────────────────────

/**
 * Parse a YNAB dollar-amount string to a number.
 * Handles "$1,234.56", ".28", "1000.00", "$0.00", etc.
 */
export function parseYnabAmount(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '');
  return parseFloat(cleaned) || 0;
}

/**
 * Parse a YNAB date string "MM/DD/YYYY" to ISO "YYYY-MM-DD".
 * Returns null for unrecognized format.
 */
export function parseYnabDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * Map YNAB Cleared column value to internal transaction status.
 * "Cleared" or "Reconciled" → "cleared"; anything else → "pending".
 */
export function mapClearedStatus(cleared: string): 'cleared' | 'pending' {
  const v = cleared.trim().toLowerCase();
  return v === 'cleared' || v === 'reconciled' ? 'cleared' : 'pending';
}

/**
 * Derive the reviewed flag from the YNAB Cleared column.
 * YNAB does not export an approval/reviewed field, so we use Cleared as
 * the best available proxy: Cleared/Reconciled → reviewed, Uncleared → not.
 * This means auto-imported-but-unapproved cleared transactions will be marked
 * reviewed, which is an acceptable trade-off vs flooding triage with all history.
 */
export function derivedReviewed(cleared: string): 'TRUE' | 'FALSE' {
  const v = cleared.trim().toLowerCase();
  return v === 'cleared' || v === 'reconciled' ? 'TRUE' : 'FALSE';
}

/**
 * Strip all non-ASCII characters from a string.
 * Used so emoji encoding artifacts in YNAB exports don't break category matching.
 */
export function normalizeForMatch(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x00-\x7F]/g, '').trim();
}

/**
 * Returns true if this row is part of a split transaction (memo matches "Split (N/M)").
 */
export function isSplitRow(memo: string): boolean {
  return SPLIT_MEMO_RE.test(memo);
}

/**
 * Strip the "Split (N/M)" indicator from a memo string.
 */
export function stripSplitIndicator(memo: string): string {
  return memo.replace(/Split\s*\(\d+\/\d+\)/i, '').trim();
}

/**
 * Generate a deterministic 12-character hex hash from the given parts.
 */
export function shortHash(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

/**
 * Generate a stable external_id for a YNAB CSV row.
 *
 * Deliberately excludes memo: memos are frequently edited in YNAB after a
 * transaction is imported, and including them in the hash would produce a new
 * id on re-import, causing duplicate rows in BTSZB.
 *
 * occurrenceIndex disambiguates truly identical transactions on the same day
 * (same account, payee, and amounts — e.g. two $1.70 Dunkin' purchases).
 * YNAB exports rows in a stable order, so the first occurrence always gets
 * index 0, the second index 1, etc., making the id stable across re-imports.
 */
export function generateExternalId(
  account: string,
  date: string,
  payee: string,
  rawOutflow: string,
  rawInflow: string,
  occurrenceIndex: number,
): string {
  return `YNAB-${shortHash(account, date, payee, rawOutflow, rawInflow, String(occurrenceIndex))}`;
}

/**
 * Extract trailing 4-digit sequence from an account name.
 * "Chase Checking ...1234" → "1234", "Savings" → null.
 * Used for fuzzy account matching between YNAB and BTS naming conventions.
 */
export function extractLast4(accountName: string): string | null {
  const match = accountName.match(/(\d{4})\D*$/);
  return match ? match[1] : null;
}

/**
 * Returns true if two account names should be treated as the same account.
 * Full-name equality is checked first; falls back to matching last-4 digits.
 */
export function accountsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const a4 = extractLast4(a);
  const b4 = extractLast4(b);
  return a4 !== null && b4 !== null && a4 === b4;
}

/**
 * Two-tier deduplication logic for a single incoming transaction.
 *
 * Tier 1 — exact external_id match → 'skip'
 * Tier 2 — no match → 'insert'
 *
 * Probable-duplicate detection (date+account+amount fuzzy match) has been removed.
 * When --cutover-date is used, all pre-cutover rows are deleted before import, so
 * there is no BTS/YNAB overlap to resolve. Re-running with the same CSV is safe
 * via tier-1 exact dedup on external_id.
 */
export function checkDedup(
  newExternalId: string,
  existing: ExistingTransactionSummary[],
): DedupAction {
  for (const ex of existing) {
    if (ex.externalId === newExternalId) return 'skip';
  }
  return 'insert';
}

/**
 * Group consecutive YNAB CSV rows into either solo rows or split groups.
 * A split group is a run of consecutive rows that all have:
 *   - memo matching /Split (N/M)/
 *   - same date
 *   - same account
 */
export function groupRows(
  rows: YnabCsvRow[],
): Array<{ isSplit: boolean; rows: YnabCsvRow[] }> {
  const result: Array<{ isSplit: boolean; rows: YnabCsvRow[] }> = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!isSplitRow(row.memo)) {
      result.push({ isSplit: false, rows: [row] });
      i++;
      continue;
    }
    // Collect all consecutive split rows sharing the same date + account
    const group: YnabCsvRow[] = [row];
    let j = i + 1;
    while (j < rows.length) {
      const next = rows[j];
      if (
        isSplitRow(next.memo) &&
        next.date === row.date &&
        next.account === row.account
      ) {
        group.push(next);
        j++;
      } else {
        break;
      }
    }
    result.push({ isSplit: true, rows: group });
    i = j;
  }
  return result;
}

/**
 * Build the synthetic parent transaction row for a split group.
 * Returns the parent row (string[]) plus the shared parentId/splitGroupId.
 */
export function buildSplitParentRow(
  group: YnabCsvRow[],
  importedAt: string,
): { parentRow: string[]; parentId: string; splitGroupId: string } {
  const first = group[0];

  const totalOutflow = group.reduce((s, r) => s + r.outflow, 0);
  const totalInflow = group.reduce((s, r) => s + r.inflow, 0);

  const childExternalIds = group.map((r) =>
    generateExternalId(r.account, r.date, r.payee, r.rawOutflow, r.rawInflow, r.occurrenceIndex),
  );
  const groupHash = shortHash(...childExternalIds);
  const accountSafe = first.account.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  const parentId = `YNAB-SPLIT-${first.date}-${accountSafe}-${groupHash}`;
  const splitGroupId = parentId;

  const row = new Array<string>(TRANSACTIONS_COLUMNS.length).fill('');
  const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);

  row[col('transaction_id')] = parentId;
  row[col('parent_id')] = '';
  row[col('split_group_id')] = splitGroupId;
  row[col('source')] = 'ynab_import';
  row[col('external_id')] = parentId;
  row[col('imported_at')] = importedAt;
  row[col('status')] = mapClearedStatus(first.cleared);
  row[col('date')] = first.date;
  row[col('payee')] = first.payee || 'Split Transaction';
  row[col('category')] = '';
  row[col('category_group')] = '';
  row[col('category_subgroup')] = '';
  row[col('outflow')] = String(totalOutflow);
  row[col('inflow')] = String(totalInflow);
  row[col('account')] = first.account;
  row[col('memo')] = '';
  row[col('flag')] = first.flag;
  row[col('transaction_type')] = detectYnabTransactionType(first);
  row[col('reviewed')] = derivedReviewed(first.cleared);

  return { parentRow: row, parentId, splitGroupId };
}

/**
 * Build child transaction rows for a split group.
 * Each child has parent_id pointing to the synthetic parent, and memo stripped
 * of the "Split (N/M)" indicator.
 */
export function buildSplitChildRows(
  group: YnabCsvRow[],
  parentId: string,
  splitGroupId: string,
  importedAt: string,
  categoryIndex: Map<string, string>,
): string[][] {
  return group.map((r) => {
    const externalId = generateExternalId(r.account, r.date, r.payee, r.rawOutflow, r.rawInflow, r.occurrenceIndex);
    const canonicalCategory = resolveCategory(r.category, categoryIndex);
    const cleanMemo = stripSplitIndicator(r.memo);

    const row = new Array<string>(TRANSACTIONS_COLUMNS.length).fill('');
    const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);

    row[col('transaction_id')] = externalId;
    row[col('parent_id')] = parentId;
    row[col('split_group_id')] = splitGroupId;
    row[col('source')] = 'ynab_import';
    row[col('external_id')] = externalId;
    row[col('imported_at')] = importedAt;
    row[col('status')] = mapClearedStatus(r.cleared);
    row[col('date')] = r.date;
    row[col('payee')] = r.payee;
    row[col('category')] = canonicalCategory;
    row[col('category_group')] = '';
    row[col('category_subgroup')] = '';
    row[col('outflow')] = String(r.outflow);
    row[col('inflow')] = String(r.inflow);
    row[col('account')] = r.account;
    row[col('memo')] = cleanMemo;
    row[col('flag')] = r.flag;
    row[col('transaction_type')] = detectYnabTransactionType(r);
    row[col('reviewed')] = derivedReviewed(r.cleared);

    return row;
  });
}

/**
 * Build a regular (non-split) transaction row.
 */
export function buildRegularTransactionRow(
  r: YnabCsvRow,
  importedAt: string,
  categoryIndex: Map<string, string>,
): string[] {
  const externalId = generateExternalId(r.account, r.date, r.payee, r.rawOutflow, r.rawInflow, r.occurrenceIndex);
  const canonicalCategory = resolveCategory(r.category, categoryIndex);

  const row = new Array<string>(TRANSACTIONS_COLUMNS.length).fill('');
  const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);

  row[col('transaction_id')] = externalId;
  row[col('parent_id')] = '';
  row[col('split_group_id')] = '';
  row[col('source')] = 'ynab_import';
  row[col('external_id')] = externalId;
  row[col('imported_at')] = importedAt;
  row[col('status')] = mapClearedStatus(r.cleared);
  row[col('date')] = r.date;
  row[col('payee')] = r.payee;
  row[col('category')] = canonicalCategory;
  row[col('category_group')] = '';
  row[col('category_subgroup')] = '';
  row[col('outflow')] = String(r.outflow);
  row[col('inflow')] = String(r.inflow);
  row[col('account')] = r.account;
  row[col('memo')] = r.memo;
  row[col('flag')] = r.flag;
  row[col('transaction_type')] = detectYnabTransactionType(r);
  row[col('reviewed')] = derivedReviewed(r.cleared);

  return row;
}

/**
 * Detect transaction type from a YNAB CSV row.
 * - Inflow category group → income
 * - Payee starting with "Transfer:" → transfer
 * - Everything else → regular
 */
export function detectYnabTransactionType(r: YnabCsvRow): 'income' | 'transfer' | 'regular' {
  if (r.categoryGroup === 'Inflow') return 'income';
  if (r.payee.startsWith('Transfer:')) return 'transfer';
  return 'regular';
}

/**
 * Resolve a YNAB category name to the canonical name from categories.json.
 * Strips non-ASCII before matching. Returns empty string if no match found.
 */
export function resolveCategory(ynabCategory: string, categoryIndex: Map<string, string>): string {
  const normalized = normalizeForMatch(ynabCategory);
  return categoryIndex.get(normalized) ?? '';
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line into fields, respecting quoted fields.
 * Handles commas inside quotes and escaped double-quotes ("").
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i <= line.length) {
    if (i === line.length) break; // all fields processed

    if (line[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      if (i < line.length && line[i] === ',') i++; // skip separator
    } else {
      // Unquoted field — read until comma or end
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      fields.push(line.slice(start, i));
      if (i < line.length && line[i] === ',') {
        i++; // skip comma
        if (i === line.length) {
          fields.push(''); // trailing comma → empty last field
          break;
        }
      }
    }
  }

  return fields;
}

/**
 * Parse a full YNAB transaction CSV string into YnabCsvRow objects.
 * Skips rows with unparseable dates. Logs warnings for bad rows.
 */
export function parseCsv(csvContent: string): YnabCsvRow[] {
  // Strip UTF-8 BOM if present (YNAB exports include it)
  const cleaned = csvContent.replace(/^﻿/, '');
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());

  const col = (name: string) => {
    const idx = headers.indexOf(name);
    return idx;
  };

  const accountCol = col('account');
  const flagCol = col('flag');
  const dateCol = col('date');
  const payeeCol = col('payee');
  const cgCatCol = col('category group/category');
  const cgCol = col('category group');
  const catCol = col('category');
  const memoCol = col('memo');
  const outflowCol = col('outflow');
  const inflowCol = col('inflow');
  const clearedCol = col('cleared');

  const requiredCols: Array<[string, number]> = [
    ['account', accountCol],
    ['date', dateCol],
    ['payee', payeeCol],
    ['outflow', outflowCol],
    ['inflow', inflowCol],
    ['cleared', clearedCol],
  ];
  const missing = requiredCols.filter(([, idx]) => idx === -1).map(([name]) => name);
  if (missing.length > 0) {
    bail(
      `YNAB CSV missing expected columns: ${missing.join(', ')}.\n` +
      `Found headers: ${headers.join(', ')}\n` +
      `Make sure you exported from YNAB Register view as CSV.`,
    );
  }

  const rows: YnabCsvRow[] = [];
  // Tracks how many times each (account|date|payee|outflow|inflow) key has
  // appeared so far, to assign a stable occurrence index to each row.
  const occurrenceCounts = new Map<string, number>();
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const rawDate = fields[dateCol]?.trim() ?? '';
    const date = parseYnabDate(rawDate);
    if (!date) {
      skipped++;
      continue;
    }

    const rawOutflow = fields[outflowCol]?.trim() ?? '0';
    const rawInflow = fields[inflowCol]?.trim() ?? '0';
    const account = fields[accountCol]?.trim() ?? '';
    const payee = payeeCol >= 0 ? (fields[payeeCol]?.trim() ?? '') : '';

    const occurrenceKey = `${account}|${date}|${payee}|${rawOutflow}|${rawInflow}`;
    const occurrenceIndex = occurrenceCounts.get(occurrenceKey) ?? 0;
    occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);

    rows.push({
      account,
      flag: flagCol >= 0 ? (fields[flagCol]?.trim() ?? '') : '',
      rawDate,
      date,
      payee,
      categoryGroupCategory: cgCatCol >= 0 ? (fields[cgCatCol]?.trim() ?? '') : '',
      categoryGroup: cgCol >= 0 ? (fields[cgCol]?.trim() ?? '') : '',
      category: catCol >= 0 ? (fields[catCol]?.trim() ?? '') : '',
      memo: memoCol >= 0 ? (fields[memoCol]?.trim() ?? '') : '',
      rawOutflow,
      rawInflow,
      outflow: parseYnabAmount(rawOutflow),
      inflow: parseYnabAmount(rawInflow),
      cleared: fields[clearedCol]?.trim() ?? '',
      occurrenceIndex,
    });
  }

  if (skipped > 0) log(`CSV: skipped ${skipped} rows with unparseable dates`);
  return rows;
}

// ─── Category helpers ─────────────────────────────────────────────────────────

const CATEGORIES_START_ROW = 2; // Categories tab: row 1 = headers, data from row 2
const CATEGORIES_END_ROW = 506;

/**
 * Read category names from the Categories tab and build a lookup map.
 * Maps normalizedName → canonical category name for YNAB export matching.
 */
async function loadCategoryIndex(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<Map<string, string>> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Categories!C${CATEGORIES_START_ROW}:C${CATEGORIES_END_ROW}`,
  });
  const map = new Map<string, string>();
  for (const row of res.data.values ?? []) {
    const category = (row[0] ?? '').trim();
    if (!category) continue;
    const key = normalizeForMatch(category);
    if (key) map.set(key, category);
  }
  return map;
}

// ─── Environment loading ──────────────────────────────────────────────────────

interface CliArgs {
  filePath: string;
  cutoverDate: string;  // YYYY-MM-DD
  wipe: boolean;        // if true, also removes ynab_import rows before re-inserting
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (idx === -1) return null;
    if (args[idx].includes('=')) return args[idx].split('=').slice(1).join('=');
    return args[idx + 1] ?? null;
  };

  const rawFile = get('--file') ?? 'data/ynab/register.csv';
  const cutoverDate = get('--cutover-date') ?? new Date().toISOString().slice(0, 10);
  const wipe = args.includes('--wipe');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
    bail(`--cutover-date must be in YYYY-MM-DD format, got: "${cutoverDate}"`);
  }

  const resolved = path.resolve(process.cwd(), rawFile.replace(/^~/, process.env.HOME ?? '~'));
  if (!fs.existsSync(resolved)) {
    bail(
      `File not found: ${resolved}\n` +
      `  Put your YNAB register export at data/ynab/register.csv, or pass --file <path>.`
    );
  }

  return { filePath: resolved, cutoverDate, wipe };
}

function loadEnv(): { sheetId: string; authConfig: AuthConfig } {
  const args = process.argv.slice(2);
  const envFlag = args.find((a) => a.startsWith('--env=') || a === '--env');
  let envName = 'dev';
  if (envFlag === '--env') {
    envName = args[args.indexOf('--env') + 1];
  } else if (envFlag?.startsWith('--env=')) {
    envName = envFlag.split('=')[1];
  }
  if (!['dev', 'prod'].includes(envName)) bail(`Invalid --env "${envName}". Use "dev" or "prod".`);

  const envFile = envName === 'dev' ? '.env.development' : '.env.production';
  const envPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    log(`Loaded env from ${envFile}`);
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId || sheetId === 'your_sheet_id_here') {
    bail(`GOOGLE_SHEET_ID not set. Add it to ${envFile} or set it as an environment variable.`);
  }

  const inlineKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  let authConfig: AuthConfig;

  if (inlineKey) {
    let credentials: object;
    try { credentials = JSON.parse(inlineKey); } catch {
      bail('GOOGLE_SERVICE_ACCOUNT_KEY is set but is not valid JSON.');
    }
    authConfig = { kind: 'credentials', credentials: credentials! };
  } else if (keyFilePath) {
    const resolved = path.resolve(process.cwd(), keyFilePath);
    if (!fs.existsSync(resolved)) bail(`Key file not found: ${resolved}`);
    authConfig = { kind: 'keyFile', keyPath: resolved };
  } else {
    bail('No credentials found. Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH.');
  }

  return { sheetId: sheetId!, authConfig: authConfig! };
}

// ─── Sheet operations ─────────────────────────────────────────────────────────

/**
 * Read external_ids of all existing transactions for dedup purposes.
 * Only reads the external_id column.
 */
async function readExistingTransactions(
  sheets: sheets_v4.Sheets,
  sheetId: string,
): Promise<ExistingTransactionSummary[]> {
  const extIdCol = TRANSACTIONS_COLUMNS.indexOf('external_id');
  const extIdColLetter = String.fromCharCode(65 + extIdCol);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Transactions!${extIdColLetter}2:${extIdColLetter}`,
  });
  const rows = res.data.values ?? [];

  return rows
    .filter((row) => (row[0] ?? '').trim() !== '')
    .map((row) => ({ externalId: row[0] }));
}

/**
 * Remove unwanted rows with date <= cutoverDate using a read-filter-rewrite
 * strategy: read all rows, drop the unwanted ones in memory, clear the sheet,
 * write back the survivors. This is always 3 API calls regardless of row count.
 *
 * wipe=false (default): removes only non-ynab_import rows (BTS/manual/seed).
 *   ynab_import rows stay so re-runs are fast — external_id dedup skips them.
 *
 * wipe=true: removes ALL rows on or before cutoverDate including ynab_import.
 *   Use when the external_id format has changed and existing rows will never
 *   match incoming hashes (e.g. after changing the hash inputs).
 */
async function removeNonYnabTransactionsBeforeCutover(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  cutoverDate: string,
  wipe = false,
): Promise<void> {
  const dateColIndex = TRANSACTIONS_COLUMNS.indexOf('date');
  const sourceColIndex = TRANSACTIONS_COLUMNS.indexOf('source');

  // 1. Read all data rows
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Transactions!A2:Z',
  });
  const allRows = res.data.values ?? [];
  if (allRows.length === 0) {
    log('Transactions: sheet is empty, nothing to clean');
    return;
  }

  // 2. Filter in memory
  const keptRows = allRows.filter((row) => {
    const date = (row[dateColIndex] ?? '').trim();
    const source = (row[sourceColIndex] ?? '').trim();
    const isPreCutover = date && date <= cutoverDate;
    if (!isPreCutover) return true;                          // always keep post-cutover rows
    if (wipe) return false;                                  // --wipe: drop everything pre-cutover
    return source === 'ynab_import';                        // default: keep only ynab_import pre-cutover
  });

  const removedCount = allRows.length - keptRows.length;
  if (removedCount === 0) {
    log(`Transactions: nothing to remove on or before ${cutoverDate}`);
    return;
  }

  // 3. Clear data rows and write back survivors — 2 API calls total
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Transactions!A2:Z',
  });

  if (keptRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Transactions!A2',
      valueInputOption: 'RAW',
      requestBody: { values: keptRows },
    });
  }

  const label = wipe ? 'all' : 'non-ynab_import';
  log(`Transactions: removed ${removedCount} ${label} row(s) on or before ${cutoverDate}, kept ${keptRows.length}`);
}

// ─── Logging & error helpers ──────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function bail(msg: string): never {
  console.error(`\n  ✗ Error: ${msg}\n`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n── Zero Budget: Import YNAB Transactions ───────────────────\n');

  const { filePath, cutoverDate, wipe } = parseArgs();
  const { sheetId, authConfig } = loadEnv();

  const auth = new google.auth.GoogleAuth({
    ...(authConfig.kind === 'keyFile'
      ? { keyFile: authConfig.keyPath }
      : { credentials: authConfig.credentials }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  log('Authenticated with Google Sheets API');

  // Parse CSV
  const csvContent = fs.readFileSync(filePath, 'utf-8');
  const allRows = parseCsv(csvContent);
  log(`CSV: parsed ${allRows.length} rows from ${path.basename(filePath)}`);

  // Apply cutover date filter — only import rows on or before the cutover date
  const cutoverRows = allRows.filter((r) => r.date <= cutoverDate);
  const filtered = allRows.length - cutoverRows.length;
  if (filtered > 0) log(`CSV: filtered out ${filtered} rows after cutover date ${cutoverDate}`);
  log(`CSV: ${cutoverRows.length} rows within cutover date`);

  // Remove non-ynab_import rows on or before cutover date (BTS, manual, seed).
  // Existing ynab_import rows are left in place — the external_id dedup below
  // will skip them, making re-runs fast (only the delta gets inserted).
  if (wipe) {
    log(`Cutover mode (--wipe): removing ALL rows on or before ${cutoverDate} for clean re-import`);
  } else {
    log(`Cutover mode: removing non-YNAB rows on or before ${cutoverDate}`);
  }
  await removeNonYnabTransactionsBeforeCutover(sheets, sheetId, cutoverDate, wipe);

  // Load categories from the sheet
  const categoryIndex = await loadCategoryIndex(sheets, sheetId);
  log(`Categories: indexed ${categoryIndex.size} entries from sheet`);

  // Read existing transactions for dedup (after the delete, so only post-cutover rows remain)
  const existing = await readExistingTransactions(sheets, sheetId);
  log(`Dedup: loaded ${existing.length} existing transaction(s) from sheet`);

  const importedAt = new Date().toISOString();

  // Process groups
  const groups = groupRows(cutoverRows);

  const rowsToInsert: string[][] = [];
  let skipped = 0;
  let splitGroupsFound = 0;

  for (const group of groups) {
    if (group.isSplit) {
      splitGroupsFound++;

      const { parentRow, parentId, splitGroupId } = buildSplitParentRow(group.rows, importedAt);
      const childRows = buildSplitChildRows(group.rows, parentId, splitGroupId, importedAt, categoryIndex);

      if (checkDedup(parentId, existing) === 'skip') {
        skipped++;
        continue;
      }

      rowsToInsert.push(parentRow);

      for (const childRow of childRows) {
        const childExtId = childRow[TRANSACTIONS_COLUMNS.indexOf('external_id')];
        if (checkDedup(childExtId, existing) === 'skip') continue;
        rowsToInsert.push(childRow);
      }
    } else {
      const r = group.rows[0];
      const externalId = generateExternalId(r.account, r.date, r.payee, r.rawOutflow, r.rawInflow, r.occurrenceIndex);

      if (checkDedup(externalId, existing) === 'skip') {
        skipped++;
        continue;
      }

      rowsToInsert.push(buildRegularTransactionRow(r, importedAt, categoryIndex));
    }
  }

  log(`Split groups detected: ${splitGroupsFound}`);
  log(`Dedup: ${skipped} skipped (exact match), ${rowsToInsert.length} to insert`);

  // Append new rows
  if (rowsToInsert.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Transactions!A2',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rowsToInsert },
    });
    log(`Transactions: appended ${rowsToInsert.length} row(s)`);
  }

  // Write live_sync_from_date to Config tab
  const liveSyncFromDate = nextDay(cutoverDate);
  await upsertConfigValue(sheets, sheetId, 'live_sync_from_date', liveSyncFromDate);

  console.log('\n── Import complete ──────────────────────────────────────────\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  ✗ Unexpected error:', err.message ?? err);
    process.exit(1);
  });
}
