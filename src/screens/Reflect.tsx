import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSheetSync } from '../hooks/useSheetSync';
import { SheetsClient } from '../api/client';
import { fetchTransactions, computeCategoryActivity } from '../api/transactions';
import { fetchBudgetCategories, fetchMonthAssignments } from '../api/budget';

const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

function toYYYYMM(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

interface MonthSummary {
  totalInflow: number;
  totalOutflow: number;
  totalAssigned: number;
  topCategories: Array<{ name: string; spent: number }>;
  uncategorizedCount: number;
}

export default function Reflect() {
  const { token } = useAuth();
  const revision = useSheetSync(token);
  const [month, setMonth] = useState(() => toYYYYMM(new Date()));
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    setLoading(true);
    setError(null);

    try {
      const [transactions, categories, assignments] = await Promise.all([
        fetchTransactions(client, { month }),
        fetchBudgetCategories(client),
        fetchMonthAssignments(client, month),
      ]);

      const nonTransfers = transactions.filter((t) => t.transaction_type !== 'transfer');
      const totalInflow = nonTransfers.reduce((s, t) => s + t.inflow, 0);
      const totalOutflow = nonTransfers.reduce((s, t) => s + t.outflow, 0);
      const totalAssigned = assignments.reduce((s, a) => s + a.assigned, 0);
      const uncategorizedCount = nonTransfers.filter((t) => !t.category).length;

      const activityMap = computeCategoryActivity(transactions);
      const topCategories = [...activityMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, spent]) => ({ name, spent }));

      setSummary({ totalInflow, totalOutflow, totalAssigned, topCategories, uncategorizedCount });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, month, revision]); // revision triggers re-fetch when sheet changes

  useEffect(() => { load(); }, [load]);

  return (
    <div className="screen reflect-screen">
      <header className="screen-header">
        <h2 className="screen-title">Reflect</h2>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="month-picker"
        />
      </header>

      {loading && <div className="state-msg">Loading…</div>}
      {error && <div className="state-msg error">{error}</div>}

      {!loading && !error && summary && (
        <>
          <div className="reflect-stats">
            <div className="stat-card">
              <span className="stat-label">Money In</span>
              <span className="stat-value positive">{fmt(summary.totalInflow)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Money Out</span>
              <span className="stat-value">{fmt(summary.totalOutflow)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Net</span>
              <span className={`stat-value ${summary.totalInflow - summary.totalOutflow < 0 ? 'negative' : 'positive'}`}>
                {fmt(summary.totalInflow - summary.totalOutflow)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Assigned</span>
              <span className="stat-value">{fmt(summary.totalAssigned)}</span>
            </div>
          </div>

          {summary.uncategorizedCount > 0 && (
            <div className="reflect-alert">
              {summary.uncategorizedCount} uncategorized transaction{summary.uncategorizedCount !== 1 ? 's' : ''} this month
            </div>
          )}

          <div className="reflect-section">
            <h3 className="reflect-section-title">Top Spending Categories</h3>
            {summary.topCategories.length === 0 ? (
              <div className="state-msg">No spending this month.</div>
            ) : (
              <div className="top-cats">
                {summary.topCategories.map((cat) => (
                  <div key={cat.name} className="top-cat-row">
                    <span className="top-cat-name">{cat.name}</span>
                    <span className="top-cat-amount">{fmt(cat.spent)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="reflect-note">
            Charts and deeper analysis coming soon.
          </p>
        </>
      )}
    </div>
  );
}
