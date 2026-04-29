import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSheetSync } from '../hooks/useSheetSync';
import { SheetsClient } from '../api/client';
import { fetchBudgetCategories, fetchMonthAssignments, buildGroupedBudget, fetchReadyToAssign } from '../api/budget';
import { fetchTransactions, computeCategoryActivity } from '../api/transactions';
import { GroupedBudget } from '../types';

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

export default function Plan() {
  const { token } = useAuth();
  const revision = useSheetSync(token);
  const [month, setMonth] = useState(() => toYYYYMM(new Date()));
  const [groups, setGroups] = useState<GroupedBudget[]>([]);
  const [readyToAssign, setReadyToAssign] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    setLoading(true);
    setError(null);

    try {
      const [categories, assignments, transactions] = await Promise.all([
        fetchBudgetCategories(client),
        fetchMonthAssignments(client, month),
        fetchTransactions(client, { month }),
      ]);
      const activityMap = computeCategoryActivity(transactions);
      setGroups(buildGroupedBudget(categories, assignments, activityMap));
      setReadyToAssign(await fetchReadyToAssign(client));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, month, revision]); // revision triggers re-fetch when sheet changes

  useEffect(() => { load(); }, [load]);

  const totalAssigned = groups.reduce((s, g) => s + g.totalAssigned, 0);
  const totalActivity = groups.reduce((s, g) => s + g.totalActivity, 0);
  const totalAvailable = groups.reduce((s, g) => s + g.totalAvailable, 0);

  return (
    <div className="screen plan-screen">
      <header className="screen-header">
        <h2 className="screen-title">Plan</h2>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="month-picker"
        />
      </header>

      <div className={`ready-to-assign${readyToAssign < 0 ? ' negative-bg' : ''}`}>
        <span className="rta-label">Ready to Assign</span>
        <span className={`rta-value${readyToAssign < 0 ? ' negative' : ' positive'}`}>
          {fmt(readyToAssign)}
        </span>
      </div>

      {loading && <div className="state-msg">Loading…</div>}
      {error && <div className="state-msg error">{error}</div>}

      {!loading && !error && (
        <>
          {/* Summary totals */}
          <div className="budget-summary">
            <div className="summary-cell">
              <span className="summary-label">Assigned</span>
              <span className="summary-value">{fmt(totalAssigned)}</span>
            </div>
            <div className="summary-cell">
              <span className="summary-label">Activity</span>
              <span className="summary-value">{fmt(totalActivity)}</span>
            </div>
            <div className="summary-cell">
              <span className={`summary-value ${totalAvailable < 0 ? 'negative' : ''}`}>
                {fmt(totalAvailable)}
              </span>
              <span className="summary-label">Available</span>
            </div>
          </div>

          {/* Column headers */}
          <div className="budget-col-headers">
            <span className="col-name">Category</span>
            <span className="col-num">Assigned</span>
            <span className="col-num">Activity</span>
            <span className="col-num">Available</span>
          </div>

          {/* Groups */}
          {groups.map((group) => (
            <div key={group.groupName} className="budget-group">
              <div className="group-header">
                <span className="group-name">{group.groupName}</span>
                <span className="col-num group-total">{fmt(group.totalAvailable)}</span>
              </div>

              {group.subgroups.map(({ subgroupName, categories }) => (
                <div key={subgroupName || '__root__'} className="budget-subgroup">
                  {subgroupName && (
                    <div className="subgroup-header">{subgroupName}</div>
                  )}
                  {categories.map((cat) => (
                    <div
                      key={cat.category}
                      className={`budget-row${cat.available < 0 ? ' overspent' : ''}`}
                    >
                      <span className="col-name">{cat.category}</span>
                      <span className="col-num">{fmt(cat.assigned)}</span>
                      <span className="col-num">{fmt(cat.activity)}</span>
                      <span className={`col-num${cat.available < 0 ? ' negative' : ''}`}>
                        {fmt(cat.available)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}

          {groups.length === 0 && (
            <div className="state-msg">No categories found. Run <code>npm run setup:dev</code> first.</div>
          )}
        </>
      )}
    </div>
  );
}
