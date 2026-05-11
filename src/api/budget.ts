import { SheetsClient } from './client';
import { BudgetCategory, BudgetAssignment, CategoryType, CategoryWithActivity, GroupedBudget, CategoryCalcs } from '../types';

// Column order must match scripts/setup-sheet.ts BUDGET_CATEGORY_COLUMNS exactly.
const CATEGORY_COLS = [
  'category_group',
  'category_subgroup',
  'category',
  'category_type',
  'monthly_template_amount',
  'sort_order',
  'active',
] as const;

// Must match BUDGET_ASSIGNMENTS_START_ROW in setup-sheet.ts.
// Row 508 = header; data starts at row 509.
const ASSIGNMENTS_START_ROW = 508;

// Must match BUDGET_CATEGORIES_START_ROW / BUDGET_CATEGORIES_END_ROW in setup-sheet.ts.
const CATEGORIES_START_ROW = 7;
const CATEGORIES_END_ROW = 506;

// ─── Parse helpers ─────────────────────────────────────────────────────────────

function parseCategoryRow(row: string[], rowIndex: number): BudgetCategory {
  const c = (name: (typeof CATEGORY_COLS)[number]) =>
    row[CATEGORY_COLS.indexOf(name)] ?? '';
  return {
    category_group: c('category_group'),
    category_subgroup: c('category_subgroup'),
    category: c('category'),
    category_type: c('category_type') as CategoryType,
    monthly_template_amount: parseFloat(c('monthly_template_amount')) || 0,
    sort_order: parseInt(c('sort_order')) || 0,
    active: c('active').toUpperCase() === 'TRUE',
    _rowIndex: rowIndex,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the Ready to Assign balance from Budget!B1 (the sheet formula).
 * The sheet formula is authoritative — it spans all months and transactions.
 */
export async function fetchReadyToAssign(client: SheetsClient): Promise<number> {
  const res = await client.getValues('Budget!B1');
  const raw = (res.values?.[0]?.[0] ?? '0').toString().replace(/^'/, '');
  return parseFloat(raw) || 0;
}

/**
 * Fetch all active budget categories from the Budget tab.
 * Sorted by sort_order ascending.
 */
export async function fetchBudgetCategories(client: SheetsClient): Promise<BudgetCategory[]> {
  const res = await client.getValues(`Budget!A${CATEGORIES_START_ROW}:G${CATEGORIES_END_ROW}`);
  const rows = res.values ?? [];
  return rows
    .map((row, i) => parseCategoryRow(row, i + CATEGORIES_START_ROW))
    .filter((c) => c.category && c.active)
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Fetch budget assignments for a specific month.
 * @param month — "YYYY-MM" format
 */
export async function fetchMonthAssignments(
  client: SheetsClient,
  month: string
): Promise<BudgetAssignment[]> {
  const res = await client.getValues(`Budget!A${ASSIGNMENTS_START_ROW + 1}:D`);
  const rows = res.values ?? [];
  return rows
    .map(
      (row, i): BudgetAssignment => ({
        month: row[0] ?? '',
        category: row[1] ?? '',
        assigned: parseFloat(row[2]) || 0,
        source: row[3] ?? 'manual',
        _rowIndex: ASSIGNMENTS_START_ROW + 1 + i,
      })
    )
    .filter((a) => a.month === month);
}

/**
 * Set the assigned amount for a category in a given month.
 * Updates in-place if an existing assignment row is provided; appends otherwise.
 */
export async function upsertAssignment(
  client: SheetsClient,
  month: string,
  category: string,
  assigned: number,
  existing?: BudgetAssignment,
  source = 'manual'
): Promise<void> {
  if (existing) {
    await client.updateValues(
      `Budget!A${existing._rowIndex}:D${existing._rowIndex}`,
      [[month, category, assigned, source]]
    );
  } else {
    await client.appendValues(`Budget!A${ASSIGNMENTS_START_ROW + 1}`, [
      [month, category, assigned, source],
    ]);
  }
}

/**
 * Upsert multiple assignments in one or two API calls (batch update for existing rows,
 * single append for new rows). Mirrors the pattern used by applyTemplate.
 */
export async function batchUpsertAssignments(
  client: SheetsClient,
  month: string,
  entries: Array<{ category: string; assigned: number; existing?: BudgetAssignment; source?: string }>
): Promise<void> {
  const updateData: { range: string; values: unknown[][] }[] = [];
  const newRows: unknown[][] = [];

  for (const entry of entries) {
    const source = entry.source ?? 'manual';
    if (entry.existing) {
      updateData.push({
        range: `Budget!A${entry.existing._rowIndex}:D${entry.existing._rowIndex}`,
        values: [[month, entry.category, entry.assigned, source]],
      });
    } else {
      newRows.push([month, entry.category, entry.assigned, source]);
    }
  }

  if (updateData.length > 0) await client.batchUpdateValues(updateData);
  if (newRows.length > 0) await client.appendValues(`Budget!A${ASSIGNMENTS_START_ROW + 1}`, newRows);
}

/**
 * Append an entry to the Budget_Log tab.
 * @param amount — delta (new assigned minus previous), not absolute value
 * @param change_type — 'manual' | 'template' | 'move_from:X' | 'move_to:X'
 */
export async function appendLogEntry(
  client: SheetsClient,
  month: string,
  category: string,
  amount: number,
  change_type: string,
  note = ''
): Promise<void> {
  await client.appendValues('Budget_Log!A2', [
    [new Date().toISOString(), month, category, amount, change_type, note],
  ]);
}

/**
 * Append multiple log entries to Budget_Log in a single API call.
 * All entries share the same timestamp.
 */
export async function batchAppendLogEntries(
  client: SheetsClient,
  entries: Array<{ month: string; category: string; amount: number; change_type: string; note?: string }>
): Promise<void> {
  const now = new Date().toISOString();
  const rows = entries.map((e) => [now, e.month, e.category, e.amount, e.change_type, e.note ?? '']);
  await client.appendValues('Budget_Log!A2', rows);
}

/**
 * Fetch pre-calculated activity and available per category for the given month
 * from the Budget_Calcs tab. Available already includes rollover from prior months.
 * @param month — "YYYY-MM" format
 */
export async function fetchCategoryCalcs(
  client: SheetsClient,
  month: string
): Promise<Map<string, CategoryCalcs>> {
  const res = await client.getValues('Budget_Calcs!A:E');
  const rows = res.values ?? [];
  const map = new Map<string, CategoryCalcs>();
  // Row 0 is headers; skip it
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if ((row[0] ?? '') !== month) continue;
    const category = row[1] ?? '';
    if (!category) continue;
    map.set(category, {
      activity: parseFloat(row[2]) || 0,
      available: parseFloat(row[4]) || 0,
    });
  }
  return map;
}

/**
 * Apply monthly template amounts for all categories that have one.
 * Batches all writes into at most 3 API calls: one batchUpdateValues for
 * in-place updates, one appendValues for new rows, one appendValues for logs.
 */
export async function applyTemplate(
  client: SheetsClient,
  month: string,
  categories: BudgetCategory[],
  existingAssignments: BudgetAssignment[]
): Promise<void> {
  const templateCats = categories.filter((c) => c.monthly_template_amount > 0);
  if (templateCats.length === 0) return;

  const assignMap = new Map(existingAssignments.map((a) => [a.category, a]));
  const updateData: { range: string; values: unknown[][] }[] = [];
  const newRows: unknown[][] = [];
  const logRows: unknown[][] = [];
  const now = new Date().toISOString();

  for (const cat of templateCats) {
    const existing = assignMap.get(cat.category);
    const amount = cat.monthly_template_amount;
    const delta = amount - (existing?.assigned ?? 0);

    if (existing) {
      updateData.push({
        range: `Budget!A${existing._rowIndex}:D${existing._rowIndex}`,
        values: [[month, cat.category, amount, 'template']],
      });
    } else {
      newRows.push([month, cat.category, amount, 'template']);
    }

    logRows.push([now, month, cat.category, delta, 'template', '']);
  }

  if (updateData.length > 0) await client.batchUpdateValues(updateData);
  if (newRows.length > 0) await client.appendValues(`Budget!A${ASSIGNMENTS_START_ROW + 1}`, newRows);
  if (logRows.length > 0) await client.appendValues('Budget_Log!A2', logRows);
}

// ─── View builders ────────────────────────────────────────────────────────────

/**
 * Merge categories, assignments, and pre-calculated calcs into a grouped budget view.
 * Activity and available come from Budget_Calcs (sheet-computed, includes rollover).
 * This is the primary data structure consumed by the Plan screen.
 */
export function buildGroupedBudget(
  categories: BudgetCategory[],
  assignments: BudgetAssignment[],
  calcMap: Map<string, CategoryCalcs>
): GroupedBudget[] {
  const assignMap = new Map(assignments.map((a) => [a.category, a.assigned]));

  // Enrich categories with sheet-computed fields
  const enriched: CategoryWithActivity[] = categories.map((cat) => {
    const assigned = assignMap.get(cat.category) ?? 0;
    const calcs = calcMap.get(cat.category) ?? { activity: 0, available: 0 };
    return { ...cat, assigned, activity: calcs.activity, available: calcs.available };
  });

  // Group → subgroup → categories
  const groupMap = new Map<string, Map<string, CategoryWithActivity[]>>();
  for (const cat of enriched) {
    if (!groupMap.has(cat.category_group)) {
      groupMap.set(cat.category_group, new Map());
    }
    const subMap = groupMap.get(cat.category_group)!;
    const subKey = cat.category_subgroup || '';
    if (!subMap.has(subKey)) subMap.set(subKey, []);
    subMap.get(subKey)!.push(cat);
  }

  const result: GroupedBudget[] = [];
  for (const [groupName, subMap] of groupMap) {
    const subgroups = [...subMap.entries()].map(([subgroupName, cats]) => ({
      subgroupName,
      categories: cats,
    }));

    const allCats = subgroups.flatMap((s) => s.categories);
    result.push({
      groupName,
      subgroups,
      totalAssigned: sum(allCats, 'assigned'),
      totalActivity: sum(allCats, 'activity'),
      totalAvailable: sum(allCats, 'available'),
    });
  }

  return result;
}

function sum(cats: CategoryWithActivity[], field: keyof CategoryWithActivity): number {
  return cats.reduce((acc, c) => acc + (c[field] as number), 0);
}
