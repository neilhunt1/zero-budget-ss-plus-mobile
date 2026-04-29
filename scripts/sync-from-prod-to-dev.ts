/**
 * sync-from-prod-to-dev.ts
 *
 * Copies all meaningful data from the prod sheet to the dev sheet.
 * Gives PR integration tests a realistic dataset without risking prod data.
 * Safe to run multiple times — fully idempotent (wipe-and-rewrite each tab).
 *
 * What gets copied:
 *   - Transactions tab (all rows)
 *   - Budget tab (rows 2+ — row 1 contains a formula managed by setup:dev)
 *   - Templates tab (all rows)
 *   - Balance History (BTS) tab (all rows)
 *   - YNAB_Plan_Import tab (all rows, if populated)
 *
 * What does NOT get copied:
 *   - BankToSheets_Raw (BTS-owned)
 *   - Reflect (formula-only charts/summaries)
 *   - YNAB_Transactions_Import (reserved, empty)
 *
 * Usage:
 *   npm run sync-from-prod-to-dev
 *
 * Required env vars (set in .env.development or as environment variables):
 *   PROD_GOOGLE_SHEET_ID            — ID of the prod sheet to read from
 *   DEV_GOOGLE_SHEET_ID             — ID of the dev sheet to write to
 *                                     (falls back to GOOGLE_SHEET_ID if not set)
 *   GOOGLE_SERVICE_ACCOUNT_KEY      — inline JSON credentials (recommended for CI)
 *   GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to key file (local dev alternative)
 */

import * as path from 'path';
import * as fs from 'fs';
import { google, sheets_v4 } from 'googleapis';

// ─── Types ────────────────────────────────────────────────────────────────────

type AuthConfig =
  | { kind: 'keyFile'; keyPath: string }
  | { kind: 'credentials'; credentials: object };

interface EnvConfig {
  prodSheetId: string;
  devSheetId: string;
  authConfig: AuthConfig;
}

export interface TabSpec {
  tabName: string;
  readRange: string;
  clearRange: string;
  writeStartRange: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Tabs to copy from prod to dev, in order
const TABS_TO_COPY = [
  'Transactions',
  'Budget',
  'Templates',
  'Balance History (BTS)',
  'YNAB_Plan_Import',
];

export const TABS_TO_SKIP = new Set([
  'BankToSheets_Raw',
  'Reflect',
  'YNAB_Transactions_Import',
]);

// ─── Pure functions (exported for unit testing) ────────────────────────────────

/**
 * Filter a list of tab names to only those we should copy.
 * Order follows TABS_TO_COPY definition; missing tabs are silently skipped.
 */
export function selectTabsToCopy(allTabNames: string[]): string[] {
  const available = new Set(allTabNames);
  return TABS_TO_COPY.filter((t) => available.has(t) && !TABS_TO_SKIP.has(t));
}

/**
 * Return the range spec for a given tab.
 * Budget tab reads from A2 (row 1 holds a ReadyToAssign formula managed by setup:dev).
 * All other tabs do a full wipe-and-rewrite from row 1.
 */
export function buildTabSpec(tabName: string): TabSpec {
  // Quote tab names that contain spaces so the Sheets API range is valid
  const q = tabName.includes(' ') ? `'${tabName}'` : tabName;
  if (tabName === 'Budget') {
    return {
      tabName,
      readRange: `${q}!A2:ZZ`,
      clearRange: `${q}!A2:ZZ`,
      writeStartRange: `${q}!A2`,
    };
  }
  return {
    tabName,
    readRange: `${q}!A1:ZZ`,
    clearRange: `${q}!A:ZZ`,
    writeStartRange: `${q}!A1`,
  };
}

// ─── Environment loading ──────────────────────────────────────────────────────

function loadEnv(): EnvConfig {
  // Load .env.development if present — provides auth + sheet IDs for local dev
  const envPath = path.resolve(process.cwd(), '.env.development');
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
    log('Loaded env from .env.development');
  }

  const prodSheetId = process.env.PROD_GOOGLE_SHEET_ID;
  if (!prodSheetId || prodSheetId === 'your_sheet_id_here') {
    bail('PROD_GOOGLE_SHEET_ID not set. Add it to .env.development or set it as an environment variable.');
  }

  // DEV_GOOGLE_SHEET_ID falls back to GOOGLE_SHEET_ID (used by the other dev scripts)
  const devSheetId = process.env.DEV_GOOGLE_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!devSheetId || devSheetId === 'your_sheet_id_here') {
    bail('DEV_GOOGLE_SHEET_ID not set. Add it to .env.development or set it as an environment variable.');
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

  return { prodSheetId: prodSheetId!, devSheetId: devSheetId!, authConfig: authConfig! };
}

// ─── Sheet operations ─────────────────────────────────────────────────────────

/** Copy one tab from prod to dev: read → clear → write. Returns row count written. */
async function copyTab(
  sheets: sheets_v4.Sheets,
  prodSheetId: string,
  devSheetId: string,
  spec: TabSpec
): Promise<number> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: prodSheetId,
    range: spec.readRange,
  });
  const rows = res.data.values ?? [];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: devSheetId,
    range: spec.clearRange,
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: devSheetId,
      range: spec.writeStartRange,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  return rows.length;
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
  console.log('\n── Zero Budget: Sync Prod → Dev ────────────────────────────\n');

  const { prodSheetId, devSheetId, authConfig } = loadEnv();

  const auth = new google.auth.GoogleAuth({
    ...(authConfig.kind === 'keyFile'
      ? { keyFile: authConfig.keyPath }
      : { credentials: authConfig.credentials }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  log('Authenticated with Google Sheets API');

  // Fail fast: verify prod is accessible before touching dev
  let prodTabNames: string[];
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: prodSheetId,
      fields: 'sheets(properties(title))',
    });
    prodTabNames = (res.data.sheets ?? [])
      .map((s) => s.properties?.title ?? '')
      .filter(Boolean);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bail(`Cannot access prod sheet (${prodSheetId}): ${msg}`);
  }

  const tabsToCopy = selectTabsToCopy(prodTabNames!);
  log(`Tabs to copy: ${tabsToCopy.join(', ')}`);

  for (const tabName of tabsToCopy) {
    const spec = buildTabSpec(tabName);
    const count = await copyTab(sheets, prodSheetId, devSheetId, spec);
    log(`${tabName}: copied ${count} row(s)`);
  }

  console.log('\n── Done ────────────────────────────────────────────────────\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  ✗ Unexpected error:', err.message ?? err);
    process.exit(1);
  });
}
