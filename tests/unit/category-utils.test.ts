import { describe, it, expect } from 'vitest';
import { handleRemovedCategory } from '../../scripts/category-utils';

describe('handleRemovedCategory', () => {
  it('archives when transactionCount > 0', () => {
    const result = handleRemovedCategory('Old Category', 5);
    expect(result.action).toBe('archive');
  });

  it('removes cleanly when transactionCount === 0', () => {
    const result = handleRemovedCategory('Old Category', 0);
    expect(result.action).toBe('remove');
  });

  it('includes the transaction count in the archive reason', () => {
    const result = handleRemovedCategory('Gym Membership', 12);
    expect(result.reason).toContain('12');
  });

  it('treats exactly 1 transaction as requiring archive', () => {
    expect(handleRemovedCategory('X', 1).action).toBe('archive');
  });

  it('reason string differs between archive and remove', () => {
    const archive = handleRemovedCategory('X', 3);
    const remove = handleRemovedCategory('X', 0);
    expect(archive.reason).not.toBe(remove.reason);
  });
});
