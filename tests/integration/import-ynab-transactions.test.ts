/**
 * Integration tests for import-ynab-transactions.ts
 * @integration
 *
 * These tests run against the dev Google Sheet and require:
 *   GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key
 *   GOOGLE_SHEET_ID set to the dev sheet
 *
 * Run with: npm run test:integration
 *
 * What is verified:
 *   - Split transactions produce a synthetic parent row + child rows in the sheet
 *   - Re-running the import produces no duplicate rows (tier-1 idempotency)
 *   - A transaction matching an existing one by date+account+amount gets status=probable_duplicate
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import {
  parseCsv,
  groupRows,
  buildSplitParentRow,
  buildSplitChildRows,
  buildRegularTransactionRow,
  checkDedup,
  generateExternalId,
  type ExistingTransactionSummary,
} from '../../scripts/import-ynab-transactions';

dotenv.config({ path: '.env.development' });

if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
}

const TIMEOUT_MS = 60_000;

const hasCredentials =
  !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const describeIf = hasCredentials ? describe : describe.skip;

const TRANSACTIONS_COLUMNS = [
  'transaction_id', 'parent_id', 'split_group_id', 'source', 'external_id',
  'imported_at', 'status', 'date', 'payee', 'description', 'category',
  'suggested_category', 'category_subgroup', 'category_group', 'category_type',
  'outflow', 'inflow', 'account', 'memo', 'transaction_type', 'transfer_pair_id',
  'flag', 'needs_reimbursement', 'reimbursement_amount', 'matched_id', 'reviewed',
];
const col = (name: string) => TRANSACTIONS_COLUMNS.indexOf(name);

// Minimal YNAB CSV for integration testing — two split rows + one regular
const TEST_CSV = [
  'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
  'Test Account,,01/15/2020,Split Payee A,Group: Cat A,Group,Cat A,Split (1/2),.50,.00,Cleared',
  'Test Account,,01/15/2020,Split Payee B,Group: Cat B,Group,Cat B,Split (2/2),.25,.00,Cleared',
  'Test Account,,01/16/2020,Regular Payee,Group: Cat A,Group,Cat A,Regular memo,10.00,.00,Uncleared',
].join('\n');

describeIf('import-ynab-transactions @integration', () => {
  let sheets: ReturnType<typeof google.sheets>;
  let sheetId: string;
  const insertedExternalIds: string[] = [];

  beforeAll(async () => {
    sheetId = process.env.GOOGLE_SHEET_ID ?? '';
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not set');

    const inlineKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const auth = new google.auth.GoogleAuth({
      ...(inlineKey
        ? { credentials: JSON.parse(inlineKey) }
        : { keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
  }, TIMEOUT_MS);

  afterAll(async () => {
    // Clean up: delete any rows we inserted during tests
    if (insertedExternalIds.length === 0) return;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Transactions!A2:Z',
    });
    const rows = res.data.values ?? [];
    const extIdCol = col('external_id');

    const idSet = new Set(insertedExternalIds);
    const rowIndices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (idSet.has(rows[i][extIdCol] ?? '')) rowIndices.push(i + 2);
    }

    if (rowIndices.length === 0) return;

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const txSheet = (spreadsheet.data.sheets ?? []).find(
      (s) => s.properties?.title === 'Transactions',
    );
    if (!txSheet) return;

    const txSheetId = txSheet.properties?.sheetId!;
    const deleteRequests = rowIndices
      .sort((a, b) => b - a)
      .map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId: txSheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex,
          },
        },
      }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: deleteRequests },
    });
  }, TIMEOUT_MS);

  it('Transactions tab exists and has expected headers', async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Transactions!A1:Z1',
    });
    const headers = res.data.values?.[0] ?? [];
    expect(headers).toContain('transaction_id');
    expect(headers).toContain('external_id');
    expect(headers).toContain('status');
    expect(headers).toContain('source');
  }, TIMEOUT_MS);

  it('split transaction produces parent row + child rows in the sheet', async () => {
    const csvRows = parseCsv(TEST_CSV);
    const groups = groupRows(csvRows);
    const splitGroup = groups.find((g) => g.isSplit);
    expect(splitGroup).toBeDefined();

    const categoryIndex = new Map<string, string>(); // no category matching needed
    const importedAt = new Date().toISOString();
    const { parentRow, parentId, splitGroupId } = buildSplitParentRow(splitGroup!.rows, importedAt);
    const childRows = buildSplitChildRows(
      splitGroup!.rows,
      parentId,
      splitGroupId,
      importedAt,
      categoryIndex,
    );

    // Track for cleanup
    insertedExternalIds.push(parentId);
    for (const child of childRows) {
      insertedExternalIds.push(child[col('external_id')]);
    }

    // Append to sheet
    const toInsert = [parentRow, ...childRows];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Transactions!A2',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toInsert },
    });

    // Read back and verify
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Transactions!A2:Z',
    });
    const allRows = res.data.values ?? [];
    const extIdCol = col('external_id');

    const parentInSheet = allRows.find((r) => r[extIdCol] === parentId);
    expect(parentInSheet).toBeDefined();
    expect(parentInSheet![col('parent_id')]).toBe('');
    expect(parentInSheet![col('split_group_id')]).toBe(parentId);

    for (const child of childRows) {
      const childExtId = child[col('external_id')];
      const childInSheet = allRows.find((r) => r[extIdCol] === childExtId);
      expect(childInSheet).toBeDefined();
      expect(childInSheet![col('parent_id')]).toBe(parentId);
      expect(childInSheet![col('split_group_id')]).toBe(splitGroupId);
    }
  }, TIMEOUT_MS);

  it('re-run produces no duplicates (tier-1 idempotency)', async () => {
    // Read existing transactions
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Transactions!A2:Z',
    });
    const allRows = res.data.values ?? [];
    const extIdCol = col('external_id');

    const existing: ExistingTransactionSummary[] = allRows
      .filter((r) => (r[extIdCol] ?? '').trim() !== '')
      .map((r) => ({
        externalId: r[extIdCol] ?? '',
        date: r[col('date')] ?? '',
        account: r[col('account')] ?? '',
        outflow: parseFloat(r[col('outflow')] ?? '0') || 0,
        inflow: parseFloat(r[col('inflow')] ?? '0') || 0,
      }));

    // All previously inserted external_ids should now dedup as 'skip'
    for (const extId of insertedExternalIds) {
      const result = checkDedup(extId, '', '', 0, 0, existing);
      expect(result).toBe('skip');
    }
  }, TIMEOUT_MS);

  it('transaction matching existing by date+account+amount gets probable_duplicate', async () => {
    const csvRows = parseCsv(TEST_CSV);
    const regularGroup = groupRows(csvRows).find((g) => !g.isSplit);
    expect(regularGroup).toBeDefined();

    const r = regularGroup!.rows[0];
    const externalId = generateExternalId(r.account, r.date, r.payee, r.rawOutflow, r.rawInflow, r.memo);

    // Simulate existing transaction with same date+account+amount but different external_id
    const existing: ExistingTransactionSummary[] = [
      {
        externalId: 'BTS-different-id',
        date: r.date,
        account: r.account,
        outflow: r.outflow,
        inflow: r.inflow,
      },
    ];

    const result = checkDedup(externalId, r.date, r.account, r.outflow, r.inflow, existing);
    expect(result).toBe('probable_duplicate');
  }, TIMEOUT_MS);
});
