/**
 * group-seed.ts
 *
 * Test data setup helpers for group budgeting E2E tests.
 * Called from plan-groups.spec.ts beforeAll — idempotent, safe to re-run.
 *
 * What it does:
 *   1. Ensures the Groups tab has the right header (setup:test may not have run yet)
 *   2. Sets the target group to by_group with a monthly_template_amount
 *   3. Clears any existing group assignment rows for that group + month
 *   4. Writes a fresh group assignment row
 */

import { readValues, writeValues, appendValues, deleteRows, getTabSheetId } from './sheets';

// Must match BUDGET_ASSIGNMENTS_START_ROW in setup-sheet.ts (header row; data at +1)
const ASSIGNMENTS_HEADER_ROW = 508;
const ASSIGNMENTS_DATA_START = 509; // 1-based
const GROUPS_COLUMNS = ['group_name', 'budget_type', 'rollover', 'rollover_start_month', 'monthly_template_amount'];

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Ensure the Groups tab header row exists and is correct.
 * Throws clearly if the tab is missing (run setup:test).
 * Only silences true 404 "not found" responses — re-throws everything else (e.g. 429).
 */
async function ensureGroupsHeader(token: string, sheetId: string): Promise<void> {
  let existing: string[][];
  try {
    existing = await readValues(token, sheetId, 'Groups!A1:E1');
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    if (status === 404 || (e as Error).message.includes('not found')) {
      throw new Error(
        '[group-seed] Groups tab missing — run `npm run setup:test` before E2E tests'
      );
    }
    throw e; // re-throw 429s and other errors rather than silently swallowing them
  }

  const current = existing[0] ?? [];
  const correct =
    current.length >= GROUPS_COLUMNS.length &&
    GROUPS_COLUMNS.every((col, i) => current[i]?.trim() === col);

  if (!correct) {
    await writeValues(token, sheetId, 'Groups!A1', [GROUPS_COLUMNS]);
    console.log('[group-seed] Groups header written');
  }
}

/**
 * Reset every group in the Groups tab back to by_category.
 * Called at the start of seedGroupForTest to ensure a clean baseline —
 * previous test runs or manual sheet edits may have left other groups as by_group.
 */
async function resetAllGroupsByCategory(token: string, sheetId: string): Promise<void> {
  const rows = await readValues(token, sheetId, 'Groups!A2:E');
  if (rows.length === 0) return;

  const updates = rows
    .map((row, i) => ({
      range: `Groups!B${i + 2}`, // budget_type column
      values: [['by_category']],
    }))
    .filter((_, i) => rows[i][0]); // skip blank rows

  if (updates.length === 0) return;

  // Batch all budget_type resets in one API call
  await Promise.all(
    updates.map(({ range, values }) => writeValues(token, sheetId, range, values))
  );
  console.log(`[group-seed] Reset ${updates.length} group(s) to by_category`);
}

/**
 * Set a group's budget_type and monthly_template_amount in the Groups tab.
 * Upserts the row (updates if group_name exists, appends if not).
 */
export async function setGroupBudgetMode(
  token: string,
  sheetId: string,
  groupName: string,
  budgetType: 'by_group' | 'by_category',
  templateAmount = 0,
): Promise<void> {
  const rows = await readValues(token, sheetId, 'Groups!A2:E');
  const rowIdx = rows.findIndex((r) => r[0]?.trim() === groupName);

  const newRow = [groupName, budgetType, 'FALSE', '', templateAmount];

  if (rowIdx >= 0) {
    // Row exists — update in place (rowIdx is 0-based, sheet row = rowIdx + 2)
    const sheetRow = rowIdx + 2;
    await writeValues(token, sheetId, `Groups!A${sheetRow}:E${sheetRow}`, [newRow]);
    console.log(`[group-seed] Updated "${groupName}" → ${budgetType} (template: ${templateAmount})`);
  } else {
    await appendValues(token, sheetId, 'Groups!A2', [newRow]);
    console.log(`[group-seed] Added "${groupName}" → ${budgetType} (template: ${templateAmount})`);
  }
}

/**
 * Remove all group assignment rows (blank category, matching group name) for a
 * given month. Needed before each test run so we start from a known state.
 */
export async function clearGroupAssignments(
  token: string,
  sheetId: string,
  groupName: string,
  month: string,
): Promise<void> {
  const rows = await readValues(token, sheetId, `Budget!A${ASSIGNMENTS_DATA_START}:E`);
  // 0-based index into the data range; add ASSIGNMENTS_DATA_START - 1 to get sheet row
  const toDelete: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [rowMonth, category, , , rowGroup] = rows[i];
    if (rowMonth === month && (category ?? '') === '' && rowGroup?.trim() === groupName) {
      toDelete.push(ASSIGNMENTS_DATA_START - 1 + i); // 0-based sheet row index
    }
  }

  if (toDelete.length === 0) {
    console.log(`[group-seed] No existing group assignments found for "${groupName}" ${month}`);
    return;
  }

  const tabId = await getTabSheetId(token, sheetId, 'Budget');
  await deleteRows(token, sheetId, tabId, toDelete);
  console.log(`[group-seed] Cleared ${toDelete.length} group assignment row(s) for "${groupName}" ${month}`);
}

/**
 * Write a group assignment row for a given month.
 * Format: month | (blank category) | amount | manual | group_name
 */
export async function writeGroupAssignment(
  token: string,
  sheetId: string,
  month: string,
  groupName: string,
  amount: number,
): Promise<void> {
  await appendValues(token, sheetId, `Budget!A${ASSIGNMENTS_DATA_START}`, [
    [month, '', amount, 'manual', groupName],
  ]);
  console.log(`[group-seed] Wrote group assignment: ${groupName} ${month} = $${amount}`);
}

/**
 * Full group test seed — call this in beforeAll.
 * Sets the group to by_group, clears old assignments, writes a fresh one.
 */
export async function seedGroupForTest(
  token: string,
  sheetId: string,
  groupName: string,
  opts: { budgetAmount: number; templateAmount: number; month?: string } = {
    budgetAmount: 1500,
    templateAmount: 2000,
  },
): Promise<void> {
  const month = opts.month ?? currentMonth();
  // Reset all groups to by_category first so no stale by_group groups pollute assertions
  await ensureGroupsHeader(token, sheetId);
  await resetAllGroupsByCategory(token, sheetId);
  // Now set only the test group to by_group
  await setGroupBudgetMode(token, sheetId, groupName, 'by_group', opts.templateAmount);
  await clearGroupAssignments(token, sheetId, groupName, month);
  await writeGroupAssignment(token, sheetId, month, groupName, opts.budgetAmount);
}
