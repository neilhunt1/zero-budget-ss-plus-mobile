import { describe, it, expect } from 'vitest';
import { resolveAccountName, getAccountLabel } from '../../src/api/accounts';
import type { Account, AccountAlias } from '../../src/types';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    canonical_name: '360 Checking',
    display_name: '',
    type: 'depository',
    active: true,
    display_order: 1,
    _rowIndex: 3,
    ...overrides,
  };
}

function makeAlias(alias: string, canonical_name: string): AccountAlias {
  return { alias, canonical_name, _rowIndex: 10 };
}

// ─── resolveAccountName ───────────────────────────────────────────────────────

describe('resolveAccountName', () => {
  const accounts = [
    makeAccount({ canonical_name: '360 Checking' }),
    makeAccount({ canonical_name: 'Quicksilver' }),
  ];
  const aliases = [
    makeAlias('CapOne 360 Checking', '360 Checking'),
    makeAlias('Capital One Quicksilver', 'Quicksilver'),
  ];

  it('returns the name directly when it matches a canonical_name', () => {
    expect(resolveAccountName('360 Checking', accounts, aliases)).toBe('360 Checking');
  });

  it('resolves via alias when the name is an alias', () => {
    expect(resolveAccountName('CapOne 360 Checking', accounts, aliases)).toBe('360 Checking');
    expect(resolveAccountName('Capital One Quicksilver', accounts, aliases)).toBe('Quicksilver');
  });

  it('returns null when the name is unrecognized', () => {
    expect(resolveAccountName('Unknown Bank', accounts, aliases)).toBeNull();
  });

  it('returns null when accounts list is empty', () => {
    expect(resolveAccountName('360 Checking', [], aliases)).toBeNull();
  });

  it('trims whitespace before matching', () => {
    expect(resolveAccountName('  360 Checking  ', accounts, aliases)).toBe('360 Checking');
  });
});

// ─── getAccountLabel ─────────────────────────────────────────────────────────

describe('getAccountLabel', () => {
  const accounts = [
    makeAccount({ canonical_name: '360 Checking', display_name: "Neil's Checking" }),
    makeAccount({ canonical_name: 'Quicksilver', display_name: '' }),
  ];

  it('returns display_name when set', () => {
    expect(getAccountLabel('360 Checking', accounts)).toBe("Neil's Checking");
  });

  it('falls back to canonical_name when display_name is blank', () => {
    expect(getAccountLabel('Quicksilver', accounts)).toBe('Quicksilver');
  });

  it('falls back to canonical_name when account is not found', () => {
    expect(getAccountLabel('Unknown Account', accounts)).toBe('Unknown Account');
  });
});
