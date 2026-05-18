import { useState, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getTransactionsByMonth, getMonthAssignments } from '../db/queries';
import { computeCategoryActivity } from '../api/transactions';

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

export default function Reflect() {
  const [month, setMonth] = useState(() => toYYYYMM(new Date()));

  const transactions = useLiveQuery(() => getTransactionsByMonth(month), [month]);
  const assignments = useLiveQuery(() => getMonthAssignments(month), [month]);
  const loading = transactions === undefined || assignments === undefined;

  const summary = useMemo(() => {
    if (!transactions || !assignments) return null;
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
    return { totalInflow, totalOutflow, totalAssigned, topCategories, uncategorizedCount };
  }, [transactions, assignments]);

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

      {!loading && summary && (
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
