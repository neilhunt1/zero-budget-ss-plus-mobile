/**
 * category-utils.ts
 *
 * Pure helper functions for category lifecycle management.
 * Kept in a standalone file so they can be unit-tested without
 * importing setup-sheet.ts (which has side effects at module load time).
 */

export type CategoryRemovalAction = 'archive' | 'remove';

export interface CategoryRemovalResult {
  /** archive → set active:false in the sheet (transactions reference this category)
   *  remove  → omit the row entirely (no transaction references, safe to drop) */
  action: CategoryRemovalAction;
  /** Human-readable explanation for the console log. */
  reason: string;
}

/**
 * Decide what to do with a category that was removed from categories.json
 * but still exists as a row in the Budget sheet.
 *
 * Rules:
 *   - transactionCount > 0 → archive (active:false). Deleting would orphan
 *     historical transactions that reference this category name.
 *   - transactionCount === 0 → remove cleanly. No data loss risk.
 *
 * Exported for unit testing — all logic is pure with no I/O.
 */
export function handleRemovedCategory(
  categoryName: string,
  transactionCount: number
): CategoryRemovalResult {
  if (transactionCount > 0) {
    return {
      action: 'archive',
      reason: `referenced by ${transactionCount} transaction(s) — setting active:false to preserve history`,
    };
  }
  return {
    action: 'remove',
    reason: 'no transaction references — safe to remove',
  };
}
