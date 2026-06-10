/**
 * config-tab.ts
 *
 * Lightweight helper for reading/writing config key-value pairs in the Meta tab.
 * Kept in its own file so import scripts can use it without triggering
 * setup-sheet.ts's main() entry point.
 *
 * Meta tab layout:
 *   Row 1: headers — key | value
 *   Rows 2–5: reserved for app dashboard values (ReadyToAssign, LastYnabSync,
 *             TotalAssignedThisMonth, TotalAvailable) — do not write here.
 *   Rows 6+: script config key-value pairs, upserted by key.
 *
 * Known config keys:
 *   live_sync_from_date  — first date owned by live BTS sync (BankToSheets/Plaid).
 *                          Written by import-ynab-transactions when --cutover-date
 *                          is passed. BTS sync skips rows before this date.
 */

import { sheets_v4 } from 'googleapis';

export const META_TAB = 'Meta';

/** Return true if a Sheets API error means the tab doesn't exist yet. */
function isMissingTabError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('Unable to parse range') || msg.includes('notFound');
}

/**
 * Ensure the Meta tab exists with a header row.
 * This is a safety net for import scripts that run before setup-sheet.
 * In normal operation setup-sheet creates Meta; this only fires if it doesn't exist.
 */
async function ensureMetaTab(sheets: sheets_v4.Sheets, sheetId: string): Promise<void> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: META_TAB } } }] },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('already exists')) throw e;
  }
  // Write header row if missing
  const hdr = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${META_TAB}!A1:B1`,
  });
  if (!hdr.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${META_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['key', 'value']] },
    });
  }
  console.log(`  ✓ Meta: tab ready`);
}

/**
 * Upsert a key/value pair in the Meta tab (rows 6+ only).
 * Reads all rows from A2:B, scans for matching key, updates in place or appends.
 * Rows 2–5 (dashboard values) are skipped — their keys won't match config keys.
 */
export async function upsertConfigValue(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  key: string,
  value: string,
): Promise<void> {
  let rows: string[][] = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${META_TAB}!A2:B`,
    });
    rows = (res.data.values ?? []) as string[][];
  } catch (e) {
    if (!isMissingTabError(e)) throw e;
    await ensureMetaTab(sheets, sheetId);
  }

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${META_TAB}!B${i + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      });
      console.log(`  ✓ Meta: updated ${key} = ${value}`);
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${META_TAB}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[key, value]] },
  });
  console.log(`  ✓ Meta: inserted ${key} = ${value}`);
}
