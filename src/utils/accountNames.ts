/**
 * Account display name lookup.
 *
 * Maps raw account strings (as they appear in the Transactions sheet, from BTS
 * or YNAB import) to short friendly display names defined in config/accounts.json.
 *
 * Falls back to the raw string if no mapping exists — new accounts always work,
 * they just show the raw name until added to the config.
 *
 * To add or rename an account: edit config/accounts.json.
 * Future: this mapping will move to an Accounts sheet tab so it is editable
 * without a code deploy.
 */

import accountsConfig from '../../config/accounts.json';

// Build alias → display_name map once at module load (case-insensitive keys)
const aliasMap = new Map<string, string>();

for (const account of accountsConfig.accounts) {
  for (const raw of Object.values(account.aliases)) {
    aliasMap.set(raw.toLowerCase(), account.display_name);
  }
}

/**
 * Returns the friendly display name for a raw account string.
 * If no mapping is found, returns the raw string unchanged.
 */
export function getAccountDisplayName(raw: string): string {
  return aliasMap.get(raw.toLowerCase()) ?? raw;
}

const CREDIT_PATTERNS = /credit\s*card|visa|mastercard|amex|american\s*express|discover/i;

/**
 * Returns 'credit' or 'depository' based on the account name.
 * Checks both the raw name and any mapped display name.
 * Used to detect credit_payment pairs (outflow from depository + inflow to credit).
 */
export function getAccountType(raw: string): 'credit' | 'depository' {
  const display = getAccountDisplayName(raw);
  if (CREDIT_PATTERNS.test(raw) || CREDIT_PATTERNS.test(display)) return 'credit';
  return 'depository';
}
