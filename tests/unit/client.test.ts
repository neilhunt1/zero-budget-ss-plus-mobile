import { describe, it, expect } from 'vitest';
import { colIndexToLetter } from '../../src/api/client';

// ─── colIndexToLetter ─────────────────────────────────────────────────────────

describe('colIndexToLetter', () => {
  it('converts single-letter columns', () => {
    expect(colIndexToLetter(0)).toBe('A');
    expect(colIndexToLetter(1)).toBe('B');
    expect(colIndexToLetter(25)).toBe('Z');
  });

  it('converts double-letter columns', () => {
    expect(colIndexToLetter(26)).toBe('AA');
    expect(colIndexToLetter(27)).toBe('AB');
    expect(colIndexToLetter(51)).toBe('AZ');
    expect(colIndexToLetter(52)).toBe('BA');
  });

  it('converts the 26 standard Sheets columns (A–Z)', () => {
    const expected = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    expected.forEach((letter, i) => {
      expect(colIndexToLetter(i)).toBe(letter);
    });
  });

  it('handles columns beyond ZZ', () => {
    // column 702 = AAA
    expect(colIndexToLetter(702)).toBe('AAA');
  });
});
