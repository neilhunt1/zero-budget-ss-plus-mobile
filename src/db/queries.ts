import { db } from './schema';
import { buildGroupedBudget } from '../api/budget';
import type { Transaction, BudgetCategory, BudgetAssignment, GroupedBudget } from '../types';

export async function getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transaction[]> {
  const results = await db.transactions
    .where('date')
    .between(startDate, endDate, true, true)
    .toArray();
  return results
    .filter((t) => !t.parent_id)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Like getTransactionsByDateRange but returns split children instead of split parents.
 * Split parents have no category (just a total); children carry the real per-category
 * amounts. Use this for spending aggregation (Reflect).
 */
export async function getTransactionsForSpending(startDate: string, endDate: string): Promise<Transaction[]> {
  const results = await db.transactions
    .where('date')
    .between(startDate, endDate, true, true)
    .toArray();
  // For non-split transactions: include rows with no parent_id and no split_group_id.
  // For split transactions: include children (have parent_id); skip the parent summary row.
  return results.filter((t) => !t.split_group_id || !!t.parent_id);
}

export async function getTransactionsByMonth(month: string): Promise<Transaction[]> {
  const results = await db.transactions
    .where('date')
    .between(`${month}-01`, `${month}-31`, true, true)
    .toArray();
  // Exclude split children, sort newest-first
  return results
    .filter((t) => !t.parent_id)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getRecentTransactions(days: number): Promise<Transaction[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const results = await db.transactions
    .where('date')
    .aboveOrEqual(cutoffStr)
    .toArray();
  return results
    .filter((t) => !t.parent_id)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function searchTransactions(query: string): Promise<Transaction[]> {
  const q = query.toLowerCase();
  const results = await db.transactions
    .filter(
      (t) =>
        t.payee?.toLowerCase().includes(q) ||
        t.category?.toLowerCase().includes(q) ||
        t.memo?.toLowerCase().includes(q)
    )
    .toArray();
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getCategorySuggestions(query: string): Promise<string[]> {
  const q = query.toLowerCase();
  const cats = await getActiveBudgetCategories();
  return cats.filter((c) => c.category.toLowerCase().includes(q)).map((c) => c.category).slice(0, 6);
}

export async function getAccountSuggestions(query: string): Promise<string[]> {
  const q = query.toLowerCase();
  const allAccounts = (await db.transactions.orderBy('account').uniqueKeys()) as string[];
  return allAccounts.filter((a) => a.toLowerCase().includes(q)).slice(0, 6);
}

export async function getPayeeSuggestions(query: string): Promise<string[]> {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  await db.transactions.each((tx) => {
    if (result.length >= 6) return;
    const p = tx.payee;
    if (p && p.toLowerCase().includes(q) && !seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  });
  return result;
}

export async function getTransactionsByPayee(payee: string): Promise<Transaction[]> {
  const results = await db.transactions.filter((t) => t.payee === payee).toArray();
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getTransactionsByAccount(account: string, textQuery?: string): Promise<Transaction[]> {
  const results = await db.transactions.where('account').equals(account).toArray();
  const filtered = textQuery
    ? results.filter((t) => {
        const q = textQuery.toLowerCase();
        return (
          t.payee?.toLowerCase().includes(q) ||
          t.category?.toLowerCase().includes(q) ||
          t.memo?.toLowerCase().includes(q)
        );
      })
    : results;
  return filtered.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getTransactionsByCategory(category: string): Promise<Transaction[]> {
  const results = await db.transactions.where('category').equals(category).toArray();
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getUnreviewedCount(): Promise<number> {
  // Dexie indexes booleans as 0/1 — filter() handles the boolean correctly
  return db.transactions.filter((t) => !t.parent_id && !t.reviewed).count();
}

export async function getActiveBudgetCategories(): Promise<BudgetCategory[]> {
  const all = await db.budgetCategories.toArray();
  return all.filter((c) => c.active).sort((a, b) => a.sort_order - b.sort_order);
}

export async function getMonthAssignments(month: string): Promise<BudgetAssignment[]> {
  return db.budgetAssignments.where('month').equals(month).toArray();
}

export async function getSuggestedCategory(payee: string): Promise<string | null> {
  const normalized = payee.toLowerCase();
  const matches = await db.transactions
    .filter((t) => t.reviewed && !!t.category && t.payee.toLowerCase() === normalized)
    .toArray();
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.date.localeCompare(a.date));
  return matches[0].category;
}

export async function getAvgDailyIncome(days: number = 90): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const results = await db.transactions
    .where('date')
    .aboveOrEqual(cutoffStr)
    .filter((t) => !t.parent_id && t.transaction_type === 'income')
    .toArray();
  const totalInflow = results.reduce((s, t) => s + t.inflow, 0);
  return totalInflow / days;
}

export async function getSplitChildren(parentId: string): Promise<Transaction[]> {
  return db.transactions
    .where('parent_id')
    .equals(parentId)
    .sortBy('transaction_id');
}

export async function getBudgetForMonth(month: string): Promise<GroupedBudget[]> {
  const [categories, assignments, calcs, groups, groupAssignments] = await Promise.all([
    getActiveBudgetCategories(),
    getMonthAssignments(month),
    db.budgetCalcs.where('month').equals(month).toArray(),
    db.budgetGroups.toArray(),
    db.budgetGroupAssignments.where('month').equals(month).toArray(),
  ]);
  const calcMap = new Map(calcs.map((c) => [c.category, { activity: c.activity, available: c.available }]));

  // Only fetch multi-month calcs when needed for rollover groups
  const hasRolloverGroups = groups.some((g) => g.rollover && g.budget_type === 'by_group');
  const allCalcs = hasRolloverGroups ? await db.budgetCalcs.toArray() : [];

  return buildGroupedBudget(categories, assignments, calcMap, groups, groupAssignments, allCalcs, month);
}
