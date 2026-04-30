/**
 * Integration tests for Budget_Calcs tab rollover behavior.
 * @integration
 *
 * These tests run against the dev Google Sheet and require:
 *   GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key
 *   GOOGLE_SHEET_ID set to the dev sheet
 *
 * Run with: npm run test:integration
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.development' });

// GOOGLE_SERVICE_ACCOUNT_KEY_PATH is the local dev alias for the key file.
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
}

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
  });

  it('Budget_Calcs tab exists with headers', async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A1:E1',
    });
    const headers = res.data.values?.[0] ?? [];
    expect(headers).toEqual(['month', 'category', 'activity', 'assigned', 'available']);
  });

  it('April available rolls over into May for a zero-spend category', async () => {
    // Find a category that has $0 activity in both April and May.
    // Its May Available should equal April Available + May Assigned.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A:E',
    });
    const rows = res.data.values ?? [];

    const forMonth = (month: string) => {
      const map = new Map<string, { activity: number; available: number }>();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if ((row[0] ?? '') !== month) continue;
        const cat = row[1] ?? '';
        if (!cat) continue;
        map.set(cat, {
          activity: parseFloat(row[2]) || 0,
          available: parseFloat(row[4]) || 0,
        });
      }
      return map;
    };

    const aprCalcs = forMonth('2026-04');
    const mayCalcs = forMonth('2026-05');

    expect(aprCalcs.size).toBeGreaterThan(0);
    expect(mayCalcs.size).toBeGreaterThan(0);

    // Find a category present in both months
    const shared = [...aprCalcs.keys()].filter((k) => mayCalcs.has(k));
    expect(shared.length).toBeGreaterThan(0);

    // For each shared category: May available must equal April available +
    // May assigned − May activity. We verify this by checking the formula
    // result is internally consistent (the sheet evaluated it).
    const aprAssignedRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Budget_Calcs!A:D',
    });
    const assignedRows = aprAssignedRes.data.values ?? [];
    const mayAssigned = new Map<string, number>();
    for (let i = 1; i < assignedRows.length; i++) {
      const row = assignedRows[i];
      if ((row[0] ?? '') !== '2026-05') continue;
      mayAssigned.set(row[1] ?? '', parseFloat(row[3]) || 0);
    }

    for (const cat of shared) {
      const aprAvail = aprCalcs.get(cat)!.available;
      const mayAct = mayCalcs.get(cat)!.activity;
      const mayAsgn = mayAssigned.get(cat) ?? 0;
      const expected = aprAvail + mayAsgn - mayAct;
      const actual = mayCalcs.get(cat)!.available;
      expect(actual).toBeCloseTo(expected, 2);
    }
  });
});
