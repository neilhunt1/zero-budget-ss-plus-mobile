/**
 * config-tab.ts
 *
 * Lightweight helper for reading/writing the Config tab.
 * Kept in its own file so import scripts can use it without
 * triggering setup-sheet.ts's main() entry point.
 *
 * Config tab layout:
 *   Row 1: headers — key | value
 *   Rows 2+: key/value pairs, upserted by key
 *
 * Known keys:
 *   live_sync_from_date  — first date owned by live sync (BTS/Plaid).
 *                          Written by import scripts when --cutover-date is passed.
 */

import { sheets_v4 } from 'googleapis';

export const CONFIG_TAB = 'Config';

/**
 * Upsert a key/value pair in the Config tab.
 * Updates the value if the key already exists; appends a new row otherwise.
 */
export async function upsertConfigValue(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${CONFIG_TAB}!A2:B`,
  });
  const rows = res.data.values ?? [];

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${CONFIG_TAB}!B${i + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      });
      console.log(`  ✓ Config: updated ${key} = ${value}`);
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${CONFIG_TAB}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[key, value]] },
  });
  console.log(`  ✓ Config: inserted ${key} = ${value}`);
}
