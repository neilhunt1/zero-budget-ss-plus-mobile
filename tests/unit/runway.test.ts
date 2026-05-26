import { describe, it, expect } from 'vitest';
import { runwayProgress, stillNeeded, estFundedDate, runwayColor } from '../../src/utils/runway';

describe('runwayProgress', () => {
  it('returns ratio of RTA to template total', () => {
    expect(runwayProgress(6200, 10000)).toBeCloseTo(0.62);
  });

  it('caps at 1.0 when RTA exceeds template total', () => {
    expect(runwayProgress(12000, 10000)).toBe(1);
  });

  it('returns 0 when RTA is negative', () => {
    expect(runwayProgress(-100, 10000)).toBe(0);
  });

  it('returns 0 when template total is 0', () => {
    expect(runwayProgress(5000, 0)).toBe(0);
  });

  it('returns exactly 1.0 when RTA equals template total', () => {
    expect(runwayProgress(10000, 10000)).toBe(1);
  });
});

describe('stillNeeded', () => {
  it('returns difference when RTA < templateTotal', () => {
    expect(stillNeeded(4000, 10000)).toBe(6000);
  });

  it('returns 0 when RTA equals templateTotal', () => {
    expect(stillNeeded(10000, 10000)).toBe(0);
  });

  it('returns 0 when RTA exceeds templateTotal', () => {
    expect(stillNeeded(12000, 10000)).toBe(0);
  });

  it('returns full templateTotal when RTA is 0', () => {
    expect(stillNeeded(0, 10000)).toBe(10000);
  });
});

describe('estFundedDate', () => {
  it('returns null when avgDailyIncome is 0', () => {
    expect(estFundedDate(5000, 0)).toBeNull();
  });

  it('returns null when still needed is 0', () => {
    expect(estFundedDate(0, 100)).toBeNull();
  });

  it('calculates correct estimate from a fixed date', () => {
    const today = new Date('2026-05-26');
    // 1000 needed at 100/day = 10 days → Jun 5
    const result = estFundedDate(1000, 100, today);
    expect(result?.toISOString().slice(0, 10)).toBe('2026-06-05');
  });

  it('ceils fractional days', () => {
    const today = new Date('2026-05-26');
    // 1050 / 100 = 10.5 → ceil = 11 → Jun 6
    const result = estFundedDate(1050, 100, today);
    expect(result?.toISOString().slice(0, 10)).toBe('2026-06-06');
  });

  it('returns null when avgDailyIncome is negative', () => {
    expect(estFundedDate(5000, -10)).toBeNull();
  });
});

describe('runwayColor', () => {
  it('returns green at exactly 100%', () => {
    expect(runwayColor(1.0)).toBe('green');
  });

  it('returns green above 100%', () => {
    expect(runwayColor(1.2)).toBe('green');
  });

  it('returns yellow at exactly 75%', () => {
    expect(runwayColor(0.75)).toBe('yellow');
  });

  it('returns yellow between 75% and 99%', () => {
    expect(runwayColor(0.9)).toBe('yellow');
  });

  it('returns red just below 75%', () => {
    expect(runwayColor(0.74)).toBe('red');
  });

  it('returns red at 0%', () => {
    expect(runwayColor(0)).toBe('red');
  });
});
