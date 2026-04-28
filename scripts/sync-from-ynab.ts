/**
 * sync-from-ynab.ts
 *
 * Re-runnable script that syncs ALL historical budget state from YNAB into the sheet.
 * Safe to run multiple times — fully idempotent.
 *
 * What it does:
 *   1. Reads YNAB Plan CSV from YNAB_Plan_Import tab (user pastes CSV there)
 *   2. Wipes all source:ynab_import Budget assignment rows
 *   3. Re-imports ALL months from the YNAB Plan CSV tagged source:ynab_import
 *   4. Reads latest balance per account from Balance History (BTS) tab
 *   5. Wipes existing source:seed opening balance transactions
 *   6. Creates one opening inflow per depository account tagged source:seed
 *   7. Writes LastYnabSync timestamp to Budget!B2
 *
 * Usage:
 *   npm run sync-from-ynab:dev
 *   npm run sync-from-ynab:prod
 *
 * Idempotency contract:
 *   - Only rows tagged source:ynab_import in Budget assignments are wiped/re-created
 *   - Only transactions tagged source:seed are wiped/re-created
 *   - source:manual and source:template rows are NEVER touched
 */

import * as path from 'path';
import * as fs from 'fs';
import { google, sheets_v4 } from 'googleapis';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CategoriesConfig {
  version: number;
  groups: Array<{
    name: string;
    sort_order?: number;
    subgroups?: Array<{
      name: string;
      sort_order?: number;
      categories: Array<{ name: string; type: string; template?: number; sort_order?: number; active?: boolean }>;
    }>;
    categories?: Array<{ name: string; type: string; template?: number; sort_order?: number; active?: boolean }>;
  }>;
}

interface FlatCategory {
  group: string;
  subgroup: string;
  category: string;
}

export interface AccountBalance {
  account: string;
  balance: number;
}

export interface YnabPlanRow {
  month: string;    // YYYY-MM
  category: string; // canonical name from categories.json
  assigned: number;
}

type AuthConfig =
  | { kind: 'keyFile'; keyPath: string }
  | { kind: 'credentials'; credentials: object };

// ─── Constants ────────────────────────────────────────────────────────────────

// Must stay in sync with setup-sheet.ts
const BUDGET_ASSIGNMENTS_START_ROW = 508; // header row
const BUDGET_ASSIGNMENTS_DATA_ROW = BUDGET_ASSIGNMENTS_START_ROW + 1;

const SKIP_GROUPS = new Set(['Hidden Categories', 'Credit Card Payments']);

const TRANSACTIONS_COLUMNS = [
  'transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
  'imported_at', 'status', 'date', 'payee', 'description', 'category',
  'suggested_category', 'category_subgroup', 'category_group', 'category_type',
  'outflow', 'inflow', 'account', 'memo', 'transaction_type', 'transfer_pair_id',
  'flag', 'needs_reimbursement', 'reimbursement_amount', 'matched_id', 'reviewed',
];

const MONTH_ABBRS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// ─── Pure functions (exported for unit testing) ────────────────────────────────

/**
 * Parse a YNAB dollar-amount string to a number.
 * Handles "$1,234.56", "-$100.00", "1000.00", etc.
 */
export function parseYnabAmount(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '');
  return parseFloat(cleaned) || 0;
}

/**
 * Strip all non-ASCII characters from a category name.
 * Used so emoji encoding artifacts in YNAB exports don't break matching.
 */
export function normalizeForMatch(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x00-\x7F]/g, '').trim();
}

/**
 * Strip the "Group: " prefix from a YNAB "Group: Category" combined column.
 * e.g. "Monthly Expenses: Groceries 🛒" → "Groceries 🛒"
 * Returns the original string unchanged if no colon-space separator is found.
 */
export function stripGroupPrefix(groupCategory: string): string {
  const idx = groupCategory.indexOf(': ');
  return idx >= 0 ? groupCategory.slice(idx + 2) : groupCategory;
}

/**
 * Parse a YNAB month string ("Apr 2026") to "YYYY-MM" format.
 * Returns null for unrecognized or malformed input.
 */
export function parseYnabMonth(raw: string): string | null {
  const parts = raw.trim().split(' ');
  if (parts.length !== 2) return null;
  const [abbr, year] = parts;
  const month = MONTH_ABBRS[abbr];
  if (!month || !/^\d{4}$/.test(year)) return null;
  return `${year}-${month}`;
}

/**
 * Build one opening-balance inflow transaction row per depository account.
 * Accounts with a non-positive balance are assumed to be credit accounts and skipped.
 * Returns rows in the same column order as TRANSACTIONS_COLUMNS.
 */
export function buildOpeningTransactions(
  accounts: AccountBalance[],
  now: Date = new Date()
): string[][] {
  const importedAt = now.toISOString();
  const date = now.toISOString().slice(0, 10);
  const rows: string[][] = [];

  for (const { account, balance } of accounts) {
    if (balance <= 0) continue;

    const safeId = account.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const txId = `seed_${safeId}`;

    const row = new Array<string>(TRANSACTIONS_COLUMNS.length).fill('');
    const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);
    row[col('transaction_id')] = txId;
    row[col('source')] = 'seed';
    row[col('imported_at')] = importedAt;
    row[col('status')] = 'cleared';
    row[col('date')] = date;
    row[col('payee')] = 'Opening Balance';
    row[col('inflow')] = String(balance);
    row[col('account')] = account;
    row[col('memo')] = 'Seeded from Balance History (BTS)';
    row[col('transaction_type')] = 'credit';
    row[col('reviewed')] = 'TRUE';
    rows.push(row);
  }

  return rows;
}

/**
 * Pure merge function: given existing assignment rows and new YNAB rows,
 * returns the merged state. Existing ynab_import rows are replaced; other
 * sources (manual, template) are preserved.
 *
 * Exported so tests can verify idempotency without Sheets API mocks.
 */
export function applyYnabAssignments(
  existingRows: string[][],
  newYnabRows: YnabPlanRow[]
): string[][] {
  const keepRows = existingRows.filter((row) => (row[3] ?? '') !== 'ynab_import');
  return [
    ...keepRows,
    ...newYnabRows.map((r) => [r.month, r.category, String(r.assigned), 'ynab_import']),
  ];
}

// ─── Categories helpers ───────────────────────────────────────────────────────

function loadFlatCategories(): FlatCategory[] {
  const dataPath = path.resolve(process.cwd(), 'config/categories.json');
  const data: CategoriesConfig = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const flat: FlatCategory[] = [];
  for (const group of data.groups) {
    if (group.subgroups) {
      for (const sg of group.subgroups) {
        for (const cat of sg.categories) {
          flat.push({ group: group.name, subgroup: sg.name, category: cat.name });
        }
      }
    } else if (group.categories) {
      for (const cat of group.categories) {
        flat.push({ group: group.name, subgroup: '', category: cat.name });
      }
    }
  }
  return flat;
}

/** Build map: normalizedName → FlatCategory for fast lookup. */
function buildCategoryIndex(flat: FlatCategory[]): Map<string, FlatCategory> {
  const map = new Map<string, FlatCategory>();
  for (const fc of flat) {
    const key = normalizeForMatch(fc.category);
    if (key) map.set(key, fc);
  }
  return map;
}

// ─── Environment loading ──────────────────────────────────────────────────────

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

/** Read and parse YNAB Plan rows from the YNAB_Plan_Import tab. */
async function readYnabPlan(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  categoryIndex: Map<string, FlatCategory>
): Promise<YnabPlanRow[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'YNAB_Plan_Import!A1:G',
  });
  const rows = res.data.values ?? [];
  if (rows.length === 0) {
    log('YNAB_Plan_Import: tab is empty — paste a YNAB Plan CSV export there first');
    return [];
  }

  // Detect columns from header row (case-insensitive, matches YNAB Plan CSV headers exactly)
  // YNAB Plan export columns: Month, Category Group/Category, Category Group, Category, Assigned, Activity, Available
  const headers = rows[0].map((h: string) => h.toLowerCase().trim());
  const monthCol = headers.indexOf('month');
  const groupCol = headers.indexOf('category group');
  const categoryCol = headers.indexOf('category');
  const assignedCol = headers.indexOf('assigned');

  if ([monthCol, groupCol, categoryCol, assignedCol].some((c) => c === -1)) {
    bail(
      `YNAB_Plan_Import: expected columns "Month", "Category Group", "Category", "Assigned" in row 1.\n` +
      `Found: ${rows[0].join(', ')}\n` +
      `Make sure you pasted the YNAB Plan CSV export (Plan view, not Register or another export type).`
    );
  }

  const results: YnabPlanRow[] = [];
  let skipped = 0;
  let unmatched = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const group = (row[groupCol] ?? '').trim();
    const ynabCategory = (row[categoryCol] ?? '').trim();
    const rawMonth = (row[monthCol] ?? '').trim();
    const rawAssigned = (row[assignedCol] ?? '0').trim();

    // Skip Credit Card Payments and Hidden Categories groups
    if (SKIP_GROUPS.has(group)) {
      skipped++;
      continue;
    }

    const month = parseYnabMonth(rawMonth);
    if (!month) {
      log(`  ⚠ Row ${i + 1}: unrecognized month "${rawMonth}" — skipping`);
      skipped++;
      continue;
    }

    const normalized = normalizeForMatch(ynabCategory);
    const fc = categoryIndex.get(normalized);
    if (!fc) {
      log(`  ⚠ Unmatched category "${ynabCategory}" (normalized: "${normalized}") — skipping`);
      unmatched++;
      continue;
    }

    results.push({ month, category: fc.category, assigned: parseYnabAmount(rawAssigned) });
  }

  log(`YNAB plan: parsed ${results.length} rows (skipped ${skipped} reserved, ${unmatched} unmatched categories)`);
  return results;
}

/**
 * Read the latest balance per account from Balance History (BTS).
 * Assumes the tab has a header row and rows ordered oldest-to-newest.
 * Columns are detected by name (flexible for different BankToSheets versions).
 */
async function readAccountBalances(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<AccountBalance[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Balance History (BTS)!A1:Z',
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) {
    log('Balance History (BTS): empty or missing data');
    return [];
  }

  const headers = rows[0].map((h: string) => h.toLowerCase().trim());
  const accountCol = headers.findIndex((h) => /account/i.test(h));
  const balanceCol = headers.findIndex((h) => /balance/i.test(h));

  if (accountCol === -1 || balanceCol === -1) {
    log(
      `Balance History (BTS): could not find account/balance columns.\n` +
      `  Headers found: ${headers.join(', ')}`
    );
    return [];
  }

  // Last row per account wins (assumes rows are oldest-to-newest)
  const latest = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const account = (row[accountCol] ?? '').trim();
    const balance = parseYnabAmount(row[balanceCol] ?? '0');
    if (account) latest.set(account, balance);
  }

  const result = [...latest.entries()].map(([account, balance]) => ({ account, balance }));
  log(`Account balances: ${result.length} accounts read from Balance History (BTS)`);
  return result;
}

/** Wipe source:ynab_import assignments and replace with new YNAB rows. */
async function wipeAndRewriteAssignments(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  newYnabRows: YnabPlanRow[]
): Promise<void> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Budget!A${BUDGET_ASSIGNMENTS_DATA_ROW}:D`,
  });
  const existing = res.data.values ?? [];
  const merged = applyYnabAssignments(existing, newYnabRows);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `Budget!A${BUDGET_ASSIGNMENTS_DATA_ROW}:D`,
  });

  if (merged.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Budget!A${BUDGET_ASSIGNMENTS_DATA_ROW}`,
      valueInputOption: 'RAW',
      requestBody: { values: merged },
    });
  }

  const keptCount = merged.length - newYnabRows.length;
  log(`Assignments: kept ${keptCount} non-ynab_import row(s), wrote ${newYnabRows.length} ynab_import row(s)`);
}

/**
 * Delete all source:seed transaction rows, then append the new seed rows.
 * Deletions happen in reverse row order to avoid index shifting.
 */
async function wipeAndRewriteSeedTransactions(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[],
  newSeedRows: string[][]
): Promise<void> {
  const txSheet = sheetMeta.find((s) => s.properties?.title === 'Transactions');
  if (!txSheet) {
    log('Transactions tab not found — skipping seed transaction sync');
    return;
  }
  const txSheetId = txSheet.properties?.sheetId!;

  // Read source column only to find seed row indices
  const sourceColIndex = TRANSACTIONS_COLUMNS.indexOf('source'); // 3
  const sourceColLetter = String.fromCharCode(65 + sourceColIndex); // 'D'

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Transactions!${sourceColLetter}2:${sourceColLetter}`,
  });
  const sourceValues = res.data.values ?? [];

  // Collect 1-based row indices in descending order for safe deletion
  const seedRowIndices: number[] = [];
  for (let i = 0; i < sourceValues.length; i++) {
    if (sourceValues[i]?.[0] === 'seed') {
      seedRowIndices.push(i + 2); // row 1 = header, data starts at row 2
    }
  }
  seedRowIndices.sort((a, b) => b - a); // highest first

  if (seedRowIndices.length > 0) {
    const deleteRequests: sheets_v4.Schema$Request[] = seedRowIndices.map((rowIndex) => ({
      deleteDimension: {
        range: {
          sheetId: txSheetId,
          dimension: 'ROWS',
          startIndex: rowIndex - 1, // 0-based
          endIndex: rowIndex,
        },
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: deleteRequests },
    });
    log(`Transactions: deleted ${seedRowIndices.length} existing seed row(s)`);
  }

  if (newSeedRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Transactions!A2',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newSeedRows },
    });
    log(`Transactions: appended ${newSeedRows.length} new seed row(s)`);
  }
}

/** Update the LastYnabSync cell in the Budget dashboard. */
async function writeLastYnabSync(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  timestamp: string
): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Budget!B2', // LastYnabSync named range cell
    valueInputOption: 'RAW',
    requestBody: { values: [[timestamp]] },
  });
  log(`LastYnabSync: ${timestamp}`);
}

// ─── Logging & Error Helpers ──────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function bail(msg: string): never {
  console.error(`\n  ✗ Error: ${msg}\n`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n── Zero Budget: Sync from YNAB ─────────────────────────────\n');

  const { sheetId, authConfig } = loadEnv();

  const auth = new google.auth.GoogleAuth({
    ...(authConfig.kind === 'keyFile'
      ? { keyFile: authConfig.keyPath }
      : { credentials: authConfig.credentials }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  log('Authenticated with Google Sheets API');

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sheetMeta = spreadsheet.data.sheets ?? [];

  const flatCategories = loadFlatCategories();
  const categoryIndex = buildCategoryIndex(flatCategories);
  log(`Categories: indexed ${categoryIndex.size} entries`);

  // Step 1: read YNAB Plan from sheet
  const ynabRows = await readYnabPlan(sheets, sheetId, categoryIndex);

  // Step 2: read account balances
  const accountBalances = await readAccountBalances(sheets, sheetId);

  const now = new Date();

  // Step 3: build seed transactions from depository account balances
  const seedRows = buildOpeningTransactions(accountBalances, now);
  log(`Seed transactions: ${seedRows.length} depository account(s) (${accountBalances.length - seedRows.length} credit account(s) skipped)`);

  // Step 4: wipe ynab_import assignments and re-import all months
  await wipeAndRewriteAssignments(sheets, sheetId, ynabRows);

  // Step 5: wipe seed transactions and re-create opening balances
  await wipeAndRewriteSeedTransactions(sheets, sheetId, sheetMeta, seedRows);

  // Step 6: stamp sync timestamp
  await writeLastYnabSync(sheets, sheetId, now.toISOString());

  console.log('\n── Sync complete ────────────────────────────────────────────\n');
}

// Guard so the script doesn't auto-run when imported by tests
if (require.main === module) {
  main().catch((err) => {
    console.error('\n  ✗ Unexpected error:', err.message ?? err);
    process.exit(1);
  });
}
