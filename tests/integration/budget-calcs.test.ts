/**
 * Integration tests for Budget_Calcs tab rollover behavior.
 * @integration
 *
 * These tests run against the dev Google Sheet and require:
 *   GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key
 *   GOOGLE_SHEET_ID set to the dev sheet
 *
 * Run with: npm run test:integration
 *
 * Uses valueRenderOption=FORMULA so we verify formula structure, not computed
 * values. This avoids triggering Google Sheets recalculation of thousands of
 * SUMIFS formulas which would cause the test to timeout in CI.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.development' });

// GOOGLE_SERVICE_ACCOUNT_KEY_PATH is the local dev alias for the key file.
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
}

const TIMEOUT_MS = 30_000;

// Skip all tests if credentials are not available
const hasCredentials =
  !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const describeIf = hasCredentials ? describe : describe.skip;

describeIf('Budget_Calcs rollover @integration', () => {
  let sheets: ReturnType<typeof google.sheets>;
  let sheetId: string;

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

  it('Budget_Calcs tab exists with correct headers', async () => {
    // FORMULA render returns raw text for non-formula cells — still fast.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A1:E1',
      valueRenderOption: 'FORMULA',
    } as Parameters<typeof sheets.spreadsheets.values.get>[0]);
    const headers = res.data.values?.[0] ?? [];
    expect(headers).toEqual(['month', 'category', 'activity', 'assigned', 'available']);
  }, TIMEOUT_MS);

  it('Budget_Calcs activity formula references Transactions tab with SUMIFS', async () => {
    // Read formula strings for the first data row — no recalculation triggered.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A2:E2',
      valueRenderOption: 'FORMULA',
    } as Parameters<typeof sheets.spreadsheets.values.get>[0]);
    const row = res.data.values?.[0] ?? [];

    expect(row[0]).toMatch(/^\d{4}-\d{2}$/);       // A2: month string
    expect(row[1]).toBeTruthy();                     // B2: category name
    expect(row[2]).toContain('Transactions');        // C2: activity formula
    expect(row[2]).toContain('SUMIFS');              // uses SUMIFS, not SUMPRODUCT
    expect(row[3]).toContain('Budget');              // D2: assigned formula
    expect(row[4]).toBe('=D2-C2');                   // E2: first month — no rollover
  }, TIMEOUT_MS);

  it('Budget_Calcs available formula chains to prior month for rollover', async () => {
    // Read the first two rows of formulas to determine N (categories per month).
    // Then verify row N+2 (first category of second month) references row 2.
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A2:B',
      valueRenderOption: 'FORMULA',
    } as Parameters<typeof sheets.spreadsheets.values.get>[0]);
    const dataRows = headerRes.data.values ?? [];

    // Count rows with the same month as row 0 to determine N.
    const firstMonth = dataRows[0]?.[0] ?? '';
    const N = dataRows.filter((r) => r[0] === firstMonth).length;
    expect(N).toBeGreaterThan(0);

    // Row index of first category in second month (1-based sheet row = N + 2).
    const secondMonthRow = N + 2;
    const formulaRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Budget_Calcs!E${secondMonthRow}`,
      valueRenderOption: 'FORMULA',
    } as Parameters<typeof sheets.spreadsheets.values.get>[0]);
    const availFormula = formulaRes.data.values?.[0]?.[0] ?? '';

    // Must reference row 2 (same category, prior month) for rollover.
    expect(availFormula).toBe(`=E2+D${secondMonthRow}-C${secondMonthRow}`);
  }, TIMEOUT_MS);
});
