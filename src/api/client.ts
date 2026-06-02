/**
 * SheetsClient — browser-compatible Google Sheets REST API client.
 *
 * Accepts a Google OAuth2 access token (obtained via useAuth).
 * All methods map directly to the Sheets v4 REST API.
 */

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Thrown when the Sheets API returns 401 — token has expired. */
export class AuthError extends Error {
  constructor() { super('Session expired'); }
}

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

  private async request<T>(path: string, options: RequestInit = {}, attempt = 0): Promise<T> {
    const url = `${BASE}/${this.sheetId}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 401) throw new AuthError();

    // 429 Too Many Requests — back off and retry up to 3 times.
    // Google Sheets API returns a Retry-After header (seconds); fall back to
    // exponential backoff (2s, 4s, 8s) if the header is absent.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt + 1) * 1000;
      console.warn(`[SheetsClient] 429 rate limit on ${path} — retrying in ${delay}ms (attempt ${attempt + 1}/3)`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return this.request<T>(path, options, attempt + 1);
    }

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
   *
   * insertDataOption controls how Google Sheets inserts the data:
   * - OVERWRITE (default): writes to existing empty cells after the last data row.
   *   Avoids triggering formula-range adjustments in Budget_Calcs SUMIFS, which
   *   can cause a brief recalculation gap with stale zero values.
   * - INSERT_ROWS: physically inserts new rows. Prefer OVERWRITE unless rows must
   *   be guaranteed to appear even when the sheet has no allocated empty rows.
   *
   * Note: for the Transactions tab specifically, use appendTransactions() which
   * avoids the :append endpoint entirely (its table-detection is unreliable on
   * large sheets) and instead does a getValues read to find the next empty row.
   */
  async appendValues(
    range: string,
    values: unknown[][],
    insertDataOption: 'OVERWRITE' | 'INSERT_ROWS' = 'OVERWRITE',
  ): Promise<void> {
    const result = await this.request<{
      tableRange?: string;
      updates?: { updatedRange?: string; updatedRows?: number; updatedCells?: number };
    }>(
      `/values/${enc(range)}:append?valueInputOption=RAW&insertDataOption=${insertDataOption}`,
      { method: 'POST', body: JSON.stringify({ range, values }) },
    );
    if (import.meta.env.DEV) {
      console.log(
        `[Sheets.append] ${range} (${insertDataOption}): ` +
        `tableRange=${result?.tableRange}, ` +
        `updatedRange=${result?.updates?.updatedRange}, ` +
        `rows=${result?.updates?.updatedRows}, ` +
        `cells=${result?.updates?.updatedCells}`,
      );
    }
    if (values.length > 0 && (result?.updates?.updatedRows ?? 0) === 0) {
      throw new Error(
        `Sheets append wrote 0 rows (${insertDataOption}); ` +
        `${values.length} row(s) sent to ${range}. ` +
        `tableRange detected: ${result?.tableRange ?? 'unknown'}`,
      );
    }
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
