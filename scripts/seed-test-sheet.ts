/**
 * seed-test-sheet.ts
 *
 * Resets the BTSZB-Test sheet to a known fixture dataset for E2E tests.
 * Run with: npm run seed:test
 *
 * Clears existing transactions and writes a fixed set covering all test scenarios.
 * Safe to re-run — always produces the same state.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { google } from 'googleapis';

// ─── Env loading (same pattern as setup-sheet.ts) ─────────────────────────────

function bail(msg: string): never {
  console.error(`\n✖  ${msg}\n`);
  process.exit(1);
}

function loadEnv(): { sheetId: string; credentials: object } {
  const envPath = path.resolve(process.cwd(), '.env.test');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    console.log('Loaded env from .env.test');
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) bail('GOOGLE_SHEET_ID is not set. Add it to .env.test.');

  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  let credentials: object;

  if (keyJson) {
    try {
      credentials = JSON.parse(keyJson);
    } catch {
      bail('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.');
    }
  } else if (keyPath) {
    const resolved = path.resolve(process.cwd(), keyPath);
    if (!fs.existsSync(resolved)) bail(`Key file not found: ${resolved}`);
    credentials = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } else {
    bail('Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH in .env.test.');
  }

  return { sheetId, credentials };
}

// ─── Transaction row builder ───────────────────────────────────────────────────

// Column order must match TRANSACTIONS_COLUMNS in setup-sheet.ts exactly.
const COLS = [
  'transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
  'imported_at', 'status', 'date', 'payee', 'description', 'category',
  'suggested_category', 'category_subgroup', 'category_group', 'category_type',
  'outflow', 'inflow', 'account', 'memo', 'transaction_type', 'transfer_pair_id',
  'flag', 'needs_reimbursement', 'reimbursement_amount', 'matched_id', 'reviewed',
] as const;

type ColName = (typeof COLS)[number];

type SeedTx = Partial<Record<ColName, string | number | boolean>> & {
  transaction_id: string;
  source: string;
  date: string;
  account: string;
};

function makeRow(tx: SeedTx): (string | number | boolean)[] {
  return COLS.map((col) => {
    const val = tx[col];
    if (val === undefined || val === null) return '';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val;
  });
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// ─── Fixed seed dataset ────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const TRANSFER_PAIR = id('t');

const SEED: SeedTx[] = [
  // 1. Uncategorized outflow — pending, not reviewed (triage candidate)
  {
    transaction_id: 'seed-001',
    source: 'seed',
    status: 'pending',
    date: '2026-05-15',
    payee: 'Amazon',
    description: 'Amazon purchase',
    outflow: 45.67,
    account: 'Chase Checking',
    transaction_type: 'expense',
    reviewed: false,
    imported_at: NOW,
  },

  // 2. Income — cleared, reviewed
  {
    transaction_id: 'seed-002',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-01',
    payee: 'Employer',
    description: 'Payroll',
    inflow: 2500,
    account: 'Chase Checking',
    transaction_type: 'income',
    reviewed: true,
    imported_at: NOW,
  },

  // 3 & 4. Transfer pair
  {
    transaction_id: 'seed-003',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-10',
    payee: 'Transfer to Savings',
    outflow: 500,
    account: 'Chase Checking',
    transaction_type: 'transfer',
    transfer_pair_id: TRANSFER_PAIR,
    reviewed: true,
    imported_at: NOW,
  },
  {
    transaction_id: 'seed-004',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-10',
    payee: 'Transfer from Checking',
    inflow: 500,
    account: 'Chase Savings',
    transaction_type: 'transfer',
    transfer_pair_id: TRANSFER_PAIR,
    reviewed: true,
    imported_at: NOW,
  },

  // 5. Reviewed categorized outflow
  {
    transaction_id: 'seed-005',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-12',
    payee: 'Whole Foods',
    category: 'Groceries 🛒',
    category_type: 'fluid',
    outflow: 89.12,
    account: 'Chase Checking',
    transaction_type: 'expense',
    reviewed: true,
    imported_at: NOW,
  },

  // 6. Pending uncategorized — triage candidate
  {
    transaction_id: 'seed-006',
    source: 'seed',
    status: 'pending',
    date: '2026-05-20',
    payee: 'Netflix',
    outflow: 15.99,
    account: 'Chase Visa',
    transaction_type: 'expense',
    reviewed: false,
    imported_at: NOW,
  },

  // 7. Cleared categorized, not reviewed — triage candidate
  {
    transaction_id: 'seed-007',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-18',
    payee: 'Dining Out',
    category: 'Dining Out 🧑‍🍳',
    category_type: 'fluid',
    outflow: 42.50,
    account: 'Chase Visa',
    transaction_type: 'expense',
    reviewed: false,
    imported_at: NOW,
  },

  // 8. Split candidate — known amount for future split E2E tests
  {
    transaction_id: 'seed-008',
    source: 'seed',
    status: 'cleared',
    date: '2026-05-22',
    payee: 'Target',
    description: 'Mixed purchase — split candidate',
    outflow: 120.00,
    account: 'Chase Checking',
    transaction_type: 'expense',
    reviewed: false,
    imported_at: NOW,
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── Zero Budget: Seed Test Sheet ─────────────────────────\n');

  const { sheetId, credentials } = loadEnv();
  console.log(`Sheet ID: ${sheetId}`);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Clear existing transaction data (keep header row 1)
  console.log('Clearing existing transactions...');
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Transactions!A2:Z',
  });

  // Write seed rows
  const rows = SEED.map(makeRow);
  console.log(`Writing ${rows.length} seed transactions...`);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Transactions!A2',
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`\n✓ Seeded ${rows.length} transactions into BTSZB-Test\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
