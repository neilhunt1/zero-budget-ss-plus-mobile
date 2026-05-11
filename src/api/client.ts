/**
 * SheetsClient — browser-compatible Google Sheets REST API client.
 *
 * Accepts a Google OAuth2 access token (obtained via useAuth).
 * All methods map directly to the Sheets v4 REST API.
 */

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetsClient {
  private readonly sheetId: string;
  private token: string;

  constructor(sheetId: string, token: string) {
    this.sheetId = sheetId;
    this.token = token;
  }

  /** Call when the OAuth token is refreshed. */
  updateToken(token: string): void {
    this.token = token;
  }

  // ─── Low-level fetch helper ──────────────────────────────────────────────────

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE}/${this.sheetId}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      let message = `Sheets API ${res.status}`;
      try {
        const body = await res.json();
        message = body?.error?.message ?? message;
      } catch { /* ignore parse errors */ }
      throw new Error(message);
    }

    return res.json() as Promise<T>;
  }

  // ─── Values API ───────────────────────────────────────────────────────────────

  async getValues(range: string): Promise<{ values?: string[][] }> {
    return this.request(`/values/${enc(range)}`);
  }

  /** PUT — overwrites the given range. */
  async updateValues(range: string, values: unknown[][]): Promise<void> {
    await this.request(
      `/values/${enc(range)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ range, values }) }
    );
  }

  /** POST — appends rows below the last non-empty row in the range.
   * Uses OVERWRITE (not INSERT_ROWS) to avoid triggering formula-range
   * adjustments in dependent sheets (Budget_Calcs SUMIFS) which cause a
   * brief recalculation gap where reads return stale zero values. */
  async appendValues(range: string, values: unknown[][]): Promise<void> {
    await this.request(
      `/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      { method: 'POST', body: JSON.stringify({ range, values }) }
    );
  }

  /** POST — update multiple non-contiguous ranges in a single request. */
  async batchUpdateValues(data: { range: string; values: unknown[][] }[]): Promise<void> {
    await this.request('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
  }

  // ─── Spreadsheet batchUpdate ─────────────────────────────────────────────────

  async batchUpdate(requests: unknown[]): Promise<void> {
    await this.request(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enc(range: string): string {
  return encodeURIComponent(range);
}

/** Convert a 0-based column index to a Sheets column letter (A, B, …, Z, AA, …). */
export function colIndexToLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}
