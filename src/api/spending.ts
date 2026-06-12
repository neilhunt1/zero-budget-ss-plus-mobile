import type { Transaction } from '../types';

export interface CategorySpend {
  category: string;
  total: number;
}

export interface SubgroupSpend {
  subgroup: string; // '' for ungrouped categories
  total: number;
  categories: CategorySpend[];
}

export interface GroupSpend {
  group: string;
  total: number;
  subgroups: SubgroupSpend[];
  categories: CategorySpend[]; // flat list (all categories across subgroups), sorted by total desc
}

export type TimeRangePreset = 'mtd' | 'last_month' | 'last_3_months' | 'ytd' | 'last_year' | 'custom';

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export function presetToDateRange(preset: TimeRangePreset, today: Date = new Date()): DateRange {
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-based
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  switch (preset) {
    case 'mtd':
      return { start: `${y}-${pad(m + 1)}-01`, end: ymd(today) };

    case 'last_month': {
      const lm = new Date(y, m - 1, 1);
      const lastDay = new Date(y, m, 0);
      return { start: ymd(lm), end: ymd(lastDay) };
    }

    case 'last_3_months': {
      const start = new Date(y, m - 3, 1);
      return { start: ymd(start), end: ymd(today) };
    }

    case 'ytd':
      return { start: `${y}-01-01`, end: ymd(today) };

    case 'last_year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };

    case 'custom':
      return { start: ymd(today), end: ymd(today) };
  }
}

/** Format a YYYY-MM-DD string as "Jan 1, 2026" */
export function formatDate(iso: string): string {
  // Parse manually to avoid timezone shift from new Date(string)
  const [y, mo, d] = iso.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function aggregateSpending(
  transactions: Transaction[],
  selectedCategories: Set<string> | null, // null = all
  categoryGroupMap?: Map<string, string>,    // category → category_group fallback
  categorySubgroupMap?: Map<string, string>, // category → category_subgroup fallback
): GroupSpend[] {
  // Only regular transactions contribute to spending. Transfers, income, and CC payments
  // each have their own transaction_type and are excluded explicitly. The caller should
  // pass split children (not split parents) so each category gets its real amount —
  // use getTransactionsForSpending() rather than getTransactionsByDateRange().
  const relevant = transactions.filter(
    (t) =>
      t.transaction_type === 'regular' &&
      (selectedCategories === null || selectedCategories.has(t.category)),
  );

  // group → subgroup → category → net (outflow - inflow)
  // inflow > 0 on a regular row means a refund/credit that reduces category spend.
  const byGroup = new Map<string, Map<string, Map<string, number>>>();

  for (const t of relevant) {
    const group = t.category_group || categoryGroupMap?.get(t.category) || 'Uncategorized';
    const subgroup = t.category_subgroup || categorySubgroupMap?.get(t.category) || '';
    const cat = t.category || 'Uncategorized';

    if (!byGroup.has(group)) byGroup.set(group, new Map());
    const subMap = byGroup.get(group)!;
    if (!subMap.has(subgroup)) subMap.set(subgroup, new Map());
    const catMap = subMap.get(subgroup)!;
    catMap.set(cat, (catMap.get(cat) ?? 0) + t.outflow - t.inflow);
  }

  return [...byGroup.entries()]
    .map(([group, subMap]) => {
      const subgroups: SubgroupSpend[] = [...subMap.entries()]
        .map(([subgroup, catMap]) => {
          const categories: CategorySpend[] = [...catMap.entries()]
            .map(([category, total]) => ({ category, total }))
            .sort((a, b) => b.total - a.total);
          return { subgroup, total: categories.reduce((s, c) => s + c.total, 0), categories };
        })
        .sort((a, b) => b.total - a.total);

      // Flat category list across all subgroups, sorted by total
      const categories: CategorySpend[] = subgroups
        .flatMap((sg) => sg.categories)
        .sort((a, b) => b.total - a.total);

      return { group, total: categories.reduce((s, c) => s + c.total, 0), subgroups, categories };
    })
    .sort((a, b) => b.total - a.total);
}
