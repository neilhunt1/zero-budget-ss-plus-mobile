import { SheetsClient } from './client';
import { Account, AccountAlias } from '../types';

// Accounts tab column indices (0-based, matching setup-sheet.ts layout)
// Section 1 (A–E): canonical_name, display_name, type, active, display_order
// Section 2 (G–H): alias, canonical_name
// Col F (index 5) is an empty separator.

const S1_CANONICAL  = 0;
const S1_DISPLAY    = 1;
const S1_TYPE       = 2;
const S1_ACTIVE     = 3;
const S1_ORDER      = 4;

const S2_ALIAS      = 6;
const S2_CANONICAL  = 7;

function parseAccount(row: string[], rowIndex: number): Account | null {
  const canonical = row[S1_CANONICAL]?.trim();
  if (!canonical) return null;
  return {
    canonical_name: canonical,
    display_name: row[S1_DISPLAY]?.trim() ?? '',
    type: row[S1_TYPE]?.trim() ?? '',
    active: row[S1_ACTIVE]?.toString().toUpperCase() === 'TRUE',
    display_order: parseInt(row[S1_ORDER] ?? '0', 10) || 0,
    _rowIndex: rowIndex,
  };
}

function parseAlias(row: string[], rowIndex: number): AccountAlias | null {
  const alias = row[S2_ALIAS]?.trim();
  const canonical = row[S2_CANONICAL]?.trim();
  if (!alias || !canonical) return null;
  return { alias, canonical_name: canonical, _rowIndex: rowIndex };
}

export interface AccountsData {
  accounts: Account[];
  aliases: AccountAlias[];
}

/**
 * Fetch all accounts and aliases from the Accounts tab.
 * Data starts at row 3 (rows 1–2 are section/column headers).
 */
export async function fetchAccounts(client: SheetsClient): Promise<AccountsData> {
  const res = await client.getValues('Accounts!A3:H');
  const rows = res.values ?? [];

  const accounts: Account[] = [];
  const aliases: AccountAlias[] = [];

  rows.forEach((row, i) => {
    const rowIndex = i + 3; // 1-based sheet row
    const account = parseAccount(row, rowIndex);
    if (account) accounts.push(account);
    const alias = parseAlias(row, rowIndex);
    if (alias) aliases.push(alias);
  });

  accounts.sort((a, b) => a.display_order - b.display_order);

  return { accounts, aliases };
}

/**
 * Resolve an account name from an external import source to a canonical_name.
 * Returns the canonical_name if it's a direct match, resolves via alias map,
 * or returns null if the name is unrecognized.
 */
export function resolveAccountName(
  name: string,
  accounts: Account[],
  aliases: AccountAlias[]
): string | null {
  const trimmed = name.trim();
  if (accounts.some((a) => a.canonical_name === trimmed)) return trimmed;
  const alias = aliases.find((a) => a.alias === trimmed);
  return alias?.canonical_name ?? null;
}

/**
 * Return the display label for an account as shown in the UI.
 * Falls back to canonical_name if display_name is blank.
 */
export function getAccountLabel(canonicalName: string, accounts: Account[]): string {
  const account = accounts.find((a) => a.canonical_name === canonicalName);
  return account?.display_name || canonicalName;
}
