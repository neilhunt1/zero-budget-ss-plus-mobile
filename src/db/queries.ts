import { db } from './schema';
import { buildGroupedBudget } from '../api/budget';
import type { Transaction, BudgetCategory, BudgetAssignment, GroupedBudget } from '../types';

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
        !t.parent_id &&
        (t.payee?.toLowerCase().includes(q) ||
          t.category?.toLowerCase().includes(q) ||
          t.memo?.toLowerCase().includes(q))
    )
    .toArray();
  return results.sort((a, b) => b.date.localeCompare(a.date));
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

export async function getBudgetForMonth(month: string): Promise<GroupedBudget[]> {
  const [categories, assignments, calcs] = await Promise.all([
    getActiveBudgetCategories(),
    getMonthAssignments(month),
    db.budgetCalcs.where('month').equals(month).toArray(),
  ]);
  const calcMap = new Map(calcs.map((c) => [c.category, { activity: c.activity, available: c.available }]));
  return buildGroupedBudget(categories, assignments, calcMap);
}
