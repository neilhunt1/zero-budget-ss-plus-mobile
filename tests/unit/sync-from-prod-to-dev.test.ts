import { describe, it, expect } from 'vitest';
import {
  selectTabsToCopy,
  buildTabSpec,
  TABS_TO_SKIP,
} from '../../scripts/sync-from-prod-to-dev';

// ─── selectTabsToCopy ─────────────────────────────────────────────────────────

describe('selectTabsToCopy', () => {
  it('returns all known copyable tabs when all are present', () => {
    const all = [
      'Transactions',
      'Budget',
      'Split Rules',
      'Balance History (BTS)',
      'Transactions (BTS)',
      'BankToSheets_Raw',
      'Reflect',
    ];
    expect(selectTabsToCopy(all)).toEqual([
      'Transactions',
      'Budget',
      'Split Rules',
      'Balance History (BTS)',
      'Transactions (BTS)',
    ]);
  });

  it('excludes every tab in TABS_TO_SKIP', () => {
    expect(selectTabsToCopy([...TABS_TO_SKIP])).toEqual([]);
  });

  it('silently skips tabs not present in the sheet', () => {
    expect(selectTabsToCopy(['Transactions', 'Budget'])).toEqual(['Transactions', 'Budget']);
  });

  it('preserves TABS_TO_COPY order regardless of input order', () => {
    const result = selectTabsToCopy(['Budget', 'Split Rules', 'Transactions']);
    expect(result).toEqual(['Transactions', 'Budget', 'Split Rules']);
  });

  it('returns empty array for empty input', () => {
    expect(selectTabsToCopy([])).toEqual([]);
  });
});

// ─── buildTabSpec ─────────────────────────────────────────────────────────────

describe('buildTabSpec', () => {
  it('Transactions: full wipe-and-rewrite from row 1', () => {
    const spec = buildTabSpec('Transactions');
    expect(spec.readRange).toBe('Transactions!A1:ZZ');
    expect(spec.clearRange).toBe('Transactions!A:ZZ');
    expect(spec.writeStartRange).toBe('Transactions!A1');
  });

  it('Budget: reads and writes from row 2, skipping the formula in row 1', () => {
    const spec = buildTabSpec('Budget');
    expect(spec.readRange).toBe('Budget!A2:ZZ');
    expect(spec.clearRange).toBe('Budget!A2:ZZ');
    expect(spec.writeStartRange).toBe('Budget!A2');
  });

  it('Split Rules: full wipe-and-rewrite from row 1', () => {
    const spec = buildTabSpec('Split Rules');
    expect(spec.readRange).toBe("'Split Rules'!A1:ZZ");
    expect(spec.clearRange).toBe("'Split Rules'!A:ZZ");
    expect(spec.writeStartRange).toBe("'Split Rules'!A1");
  });

  it('Balance History (BTS): quotes tab name correctly for Sheets range syntax', () => {
    const spec = buildTabSpec('Balance History (BTS)');
    expect(spec.readRange).toBe("'Balance History (BTS)'!A1:ZZ");
    expect(spec.clearRange).toBe("'Balance History (BTS)'!A:ZZ");
    expect(spec.writeStartRange).toBe("'Balance History (BTS)'!A1");
  });

  it('tabName is preserved on the spec', () => {
    expect(buildTabSpec('Transactions').tabName).toBe('Transactions');
    expect(buildTabSpec('Budget').tabName).toBe('Budget');
  });
});
