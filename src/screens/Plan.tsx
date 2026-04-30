import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSheetSync } from '../hooks/useSheetSync';
import { SheetsClient } from '../api/client';
import {
  fetchBudgetCategories,
  fetchMonthAssignments,
  fetchCategoryCalcs,
  buildGroupedBudget,
  fetchReadyToAssign,
  upsertAssignment,
  appendLogEntry,
} from '../api/budget';
import { GroupedBudget, BudgetAssignment, BudgetCategory, CategoryWithActivity } from '../types';

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

interface EditState {
  cat: CategoryWithActivity;
  existing: BudgetAssignment | undefined;
  inputValue: string;
  saving: boolean;
  saveError: string | null;
}

export default function Plan() {
  const { token } = useAuth();
  const revision = useSheetSync(token);
  const [month, setMonth] = useState(() => toYYYYMM(new Date()));
  const [groups, setGroups] = useState<GroupedBudget[]>([]);
  const [assignments, setAssignments] = useState<BudgetAssignment[]>([]);
  const [readyToAssign, setReadyToAssign] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    setLoading(true);
    setError(null);

    try {
      const [cats, rawAssignments, calcs] = await Promise.all([
        fetchBudgetCategories(client),
        fetchMonthAssignments(client, month),
        fetchCategoryCalcs(client, month),
      ]);
      setCategories(cats);
      setAssignments(rawAssignments);
      setGroups(buildGroupedBudget(cats, rawAssignments, calcs));
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

  const handleRowClick = (cat: CategoryWithActivity) => {
    const existing = assignments.find((a) => a.category === cat.category);
    setEditState({
      cat,
      existing,
      inputValue: cat.assigned === 0 ? '' : String(cat.assigned),
      saving: false,
      saveError: null,
    });
  };

  const handleCancel = () => setEditState(null);

  const handleApplyTemplate = async () => {
    if (!token) return;
    const templateCats = categories.filter((c) => c.monthly_template_amount > 0);
    if (templateCats.length === 0) return;

    const hasExisting = assignments.length > 0;
    if (hasExisting) {
      const ok = window.confirm('This will overwrite existing assignments. Continue?');
      if (!ok) return;
    }

    setApplyingTemplate(true);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      for (const cat of templateCats) {
        const existing = assignments.find((a) => a.category === cat.category);
        await upsertAssignment(client, month, cat.category, cat.monthly_template_amount, existing, 'template');
        const delta = cat.monthly_template_amount - (existing?.assigned ?? 0);
        await appendLogEntry(client, month, cat.category, delta, 'template');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyingTemplate(false);
    }
  };

  const handleSave = async () => {
    if (!editState || !token) return;
    const amount = parseFloat(editState.inputValue) || 0;
    const { cat, existing } = editState;
    setEditState((prev) => prev ? { ...prev, saving: true, saveError: null } : null);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      await upsertAssignment(client, month, cat.category, amount, existing);
      const delta = amount - (existing?.assigned ?? 0);
      await appendLogEntry(client, month, cat.category, delta, 'manual');
      setEditState(null);
      await load();
    } catch (e) {
      setEditState((prev) =>
        prev ? { ...prev, saving: false, saveError: (e as Error).message } : null
      );
    }
  };

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
        <button
          type="button"
          className="btn-secondary apply-template-btn"
          onClick={handleApplyTemplate}
          disabled={applyingTemplate || loading || categories.every((c) => c.monthly_template_amount === 0)}
        >
          {applyingTemplate ? 'Applying…' : 'Apply Template'}
        </button>
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
                    <button
                      key={cat.category}
                      type="button"
                      className={`budget-row${cat.available < 0 ? ' overspent' : ''}`}
                      onClick={() => handleRowClick(cat)}
                    >
                      <span className="col-name">{cat.category}</span>
                      <span className="col-num">{fmt(cat.assigned)}</span>
                      <span className="col-num">{fmt(cat.activity)}</span>
                      <span className={`col-num${cat.available < 0 ? ' negative' : ''}`}>
                        {fmt(cat.available)}
                      </span>
                    </button>
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

      {editState && (
        <div className="assign-overlay" onClick={handleCancel}>
          <div className="assign-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="assign-sheet-handle" />
            <div className="assign-sheet-title">{editState.cat.category}</div>
            <label className="assign-label" htmlFor="assign-input">Assigned amount</label>
            <input
              id="assign-input"
              className="assign-input"
              type="number"
              inputMode="decimal"
              value={editState.inputValue}
              onChange={(e) =>
                setEditState((prev) => prev ? { ...prev, inputValue: e.target.value } : null)
              }
              placeholder="0"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            {editState.saveError && (
              <div className="assign-save-error">{editState.saveError}</div>
            )}
            <div className="assign-sheet-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCancel}
                disabled={editState.saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSave}
                disabled={editState.saving}
              >
                {editState.saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
