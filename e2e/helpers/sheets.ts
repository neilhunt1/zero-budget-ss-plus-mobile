/**
 * Thin Sheets REST API wrapper for E2E test setup.
 * Uses Bearer token auth (service account) — same token injected into the browser.
 */

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsRequest<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    let msg = `Sheets API ${res.status} on ${path}`;
    try { msg = (await res.json())?.error?.message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function readValues(
  token: string,
  sheetId: string,
  range: string,
): Promise<string[][]> {
  const data = await sheetsRequest<{ values?: string[][] }>(
    token,
    `${sheetId}/values/${encodeURIComponent(range)}`,
  );
  return data.values ?? [];
}

export async function writeValues(
  token: string,
  sheetId: string,
  range: string,
  values: unknown[][],
): Promise<void> {
  await sheetsRequest(
    token,
    `${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values }) },
  );
}

export async function appendValues(
  token: string,
  sheetId: string,
  range: string,
  values: unknown[][],
): Promise<void> {
  await sheetsRequest(
    token,
    `${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) },
  );
}

export async function clearRange(
  token: string,
  sheetId: string,
  range: string,
): Promise<void> {
  await sheetsRequest(
    token,
    `${sheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', body: '{}' },
  );
}

/**
 * Delete specific rows (0-based indices, descending order to avoid shifting).
 * tabSheetId is the integer sheet ID (not the spreadsheet ID).
 */
export async function deleteRows(
  token: string,
  sheetId: string,
  tabSheetId: number,
  rowIndices: number[],
): Promise<void> {
  if (rowIndices.length === 0) return;
  const sorted = [...rowIndices].sort((a, b) => b - a); // descending — avoids index shifts
  const requests = sorted.map((i) => ({
    deleteRange: {
      range: { sheetId: tabSheetId, startRowIndex: i, endRowIndex: i + 1 },
      shiftDimension: 'ROWS',
    },
  }));
  await sheetsRequest(
    token,
    `${sheetId}:batchUpdate`,
    { method: 'POST', body: JSON.stringify({ requests }) },
  );
}

/** Return the integer sheetId for a named tab. */
export async function getTabSheetId(
  token: string,
  sheetId: string,
  tabTitle: string,
): Promise<number> {
  const data = await sheetsRequest<{ sheets: Array<{ properties: { title: string; sheetId: number } }> }>(
    token,
    `${sheetId}?fields=sheets(properties(title,sheetId))`,
  );
  const tab = data.sheets.find((s) => s.properties.title === tabTitle);
  if (!tab) throw new Error(`Tab "${tabTitle}" not found in spreadsheet`);
  return tab.properties.sheetId;
}
