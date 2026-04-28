import { SheetsClient } from './client';
import { BudgetCategory, BudgetAssignment, CategoryType, CategoryWithActivity, GroupedBudget } from '../types';

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

// ─── View builders ────────────────────────────────────────────────────────────

/**
 * Merge categories, assignments, and activity into a grouped budget view.
 * This is the primary data structure consumed by the Plan screen.
 */
export function buildGroupedBudget(
  categories: BudgetCategory[],
  assignments: BudgetAssignment[],
  activityMap: Map<string, number>
): GroupedBudget[] {
  const assignMap = new Map(assignments.map((a) => [a.category, a.assigned]));

  // Enrich categories with computed fields
  const enriched: CategoryWithActivity[] = categories.map((cat) => {
    const assigned = assignMap.get(cat.category) ?? 0;
    const activity = activityMap.get(cat.category) ?? 0;
    return { ...cat, assigned, activity, available: assigned - activity };
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
