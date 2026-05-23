import { describe, it, expect } from 'vitest';
import { getAccountDisplayName } from '../../src/utils/accountNames';

describe('getAccountDisplayName', () => {
  it('resolves BTS account strings to display names', () => {
    expect(getAccountDisplayName('Chase CREDIT CARD (2898)')).toBe('IHG MasterCard');
    expect(getAccountDisplayName('Chase CREDIT CARD (8368)')).toBe('Prime Visa');
    expect(getAccountDisplayName('Chase-Disney CREDIT CARD (2950)')).toBe('Disney Visa');
    expect(getAccountDisplayName('Capital One 360 Checking (6650)')).toBe('CapitalOne Checking');
    expect(getAccountDisplayName('Capital One 360 Performance Savings (6128)')).toBe('CapitalOne Savings');
  });

  it('resolves YNAB account strings to the same display names', () => {
    expect(getAccountDisplayName('IHG One Rewards Premier Credit Card - CREDIT CARD')).toBe('IHG MasterCard');
    expect(getAccountDisplayName('Prime Visa - CREDIT CARD')).toBe('Prime Visa');
    expect(getAccountDisplayName('Disney Visa')).toBe('Disney Visa');
    expect(getAccountDisplayName('360 Checking')).toBe('CapitalOne Checking');
    expect(getAccountDisplayName('360 Performance Savings')).toBe('CapitalOne Savings');
  });

  it('is case-insensitive', () => {
    expect(getAccountDisplayName('CHASE CREDIT CARD (2898)')).toBe('IHG MasterCard');
    expect(getAccountDisplayName('chase credit card (2898)')).toBe('IHG MasterCard');
  });

  it('falls back to the raw string for unknown accounts', () => {
    expect(getAccountDisplayName('Some New Bank (9999)')).toBe('Some New Bank (9999)');
    expect(getAccountDisplayName('')).toBe('');
  });
});
