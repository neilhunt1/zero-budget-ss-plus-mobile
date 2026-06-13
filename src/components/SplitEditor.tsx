import { useState, useMemo } from 'react';
import { SheetsClient, AuthError } from '../api/client';
import { optimisticSplitTransaction, optimisticEditSplitChildren } from '../db/optimisticWrites';
import { useAuth } from '../hooks/useAuth';
import type { Transaction, BudgetCategory } from '../types';

const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

/**
 * SplitEditor — create or edit a parent/child split transaction.
 *
 * ─── Edge cases captured for future E2E automation (issue #29) ───────────────
 *
 * VALIDATION
 *  1. Amounts don't sum to parent → Save button disabled; indicator shows
 *     remaining amount in amber (under) or red (over). Balanced ✓ and Save
 *     enabled only when |remainder| < $0.01.
 *  2. Zero-amount lines → blocked (each line must be !== 0); keeps Save disabled
 *     even when totals happen to balance.
 *  3. Negative amounts in a split line are allowed — e.g. a $41 purchase and a
 *     −$12.55 return in one $28.45 transaction. Validation uses !== 0, not > 0.
 *  4. "Balanced ✓" display and Save button disabled-state must always agree;
 *     previously they could diverge (display showed balanced, button greyed out).
 *
 * LINE MANAGEMENT
 *  5. Minimum two lines enforced — remove button is hidden when only two lines
 *     remain (regardless of mode).
 *  6. Edit mode: lines corresponding to existing sheet children (_childId set)
 *     never show a remove button; only newly added lines can be removed.
 *  7. "Set Remaining ↓" button is disabled when remainder ≤ 0 (can't fill
 *     a line by subtracting). If adding remainder to the current amount would
 *     produce a non-positive result the update is silently skipped.
 *  8. Category picker — only one picker open at a time; opening a second one
 *     closes the first.
 *
 * PERSISTENCE
 *  9. Optimistic write order: IndexedDB first → Sheets second. On Sheets
 *     failure the catch block reverts IndexedDB and re-throws; user sees
 *     "Save failed" and the split is fully rolled back.
 * 10. Sheets `:append` endpoint is NOT used for transaction rows. On sheets
 *     with 28k+ rows the endpoint returns tableRange: undefined and either
 *     writes 0 rows (OVERWRITE) or inserts at the anchor cell, corrupting row
 *     order. appendTransactions() now does GET Transactions!A:A → PUT to the
 *     computed next empty row instead.
 * 11. Newly created split children have _rowIndex: 0 (placeholder) until the
 *     next full sync assigns real row indices. optimisticEditSplitChildren
 *     skips the Sheets updateValues call for any child still at _rowIndex: 0.
 * 12. IndexedDB orphans (children written locally but never confirmed in
 *     Sheets) are purged during syncOnOpen, which now deletes records absent
 *     from the fetched sheet data before bulkPut-ing the fresh snapshot.
 *
 * UI / NAVIGATION
 * 13. Desktop: clicking "Split" on a transaction must not collapse the detail
 *     panel. Render condition uses (isSelected || splitTx?.id === tx.id)
 *     rather than isSelected alone.
 * 14. After saving a split the parent row shows "Split" in the category cell
 *     (not "Uncategorized") and a ▼ N splits expand toggle.
 * 15. In edit mode TxDetailEditor shows a split summary and "Modify splits"
 *     instead of the category picker + "Split" button.
 * 16. canSplit checks !tx.split_group_id — re-splitting an already-split
 *     parent is blocked.
 *
 * TRIAGE & BUDGET
 * 17. Split children have reviewed: true so they never appear in Triage.
 *     Triage queries also filter !parent_id as an additional guard.
 * 18. Budget_Calcs SUMIFS already filter parent_id = "" — children contribute
 *     to category activity correctly without double-counting the parent.
 * 19. Negative-outflow split children reduce the category's activity (net
 *     spend), which is the correct behaviour for an in-transaction refund.
 *
 * SYNC
 * 20. ↻ NavBar button clears syncMeta.lastSheetVersion and immediately fires
 *     a Drive version check, allowing an on-demand full re-sync without
 *     waiting for the 15-second polling interval.
 */

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

type SplitLine = {
  _key: string;
  /** Set when this line corresponds to an existing split child (edit mode). */
  _childId?: string;
  /** The existing child's sheet row index; 0 = not yet synced. */
  _childRowIndex?: number;
  payee: string;
  category: string;
  outflow: string;
};

function makeLine(payee: string, childId?: string, childRowIndex?: number): SplitLine {
  return {
    _key: crypto.randomUUID(),
    _childId: childId,
    _childRowIndex: childRowIndex,
    payee,
    category: '',
    outflow: '',
  };
}

interface SplitEditorProps {
  parent: Transaction;
  categories: BudgetCategory[];
  /** Populated when editing an existing split; omit or pass [] for a new split. */
  existingChildren?: Transaction[];
  onClose: () => void;
  onSaved: () => void;
  isDesktop: boolean;
  token: string | null;
}

export default function SplitEditor({
  parent,
  categories,
  existingChildren = [],
  onClose,
  onSaved,
  isDesktop,
  token,
}: SplitEditorProps) {
  const { notifySessionExpired } = useAuth();
  const isEditMode = existingChildren.length > 0;

  const [splitLines, setSplitLines] = useState<SplitLine[]>(() => {
    if (isEditMode) {
      return existingChildren.map((c) => ({
        _key: crypto.randomUUID(),
        _childId: c.transaction_id,
        _childRowIndex: c._rowIndex,
        payee: c.payee,
        category: c.category,
        outflow: String(-c.amount),
      }));
    }
    return [makeLine(parent.payee), makeLine(parent.payee)];
  });

  const [openCatKey, setOpenCatKey] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOutflow = -parent.amount;
  const splitTotal = splitLines.reduce((sum, l) => sum + (parseFloat(l.outflow) || 0), 0);
  const remainder = Math.round((parentOutflow - splitTotal) * 100) / 100;
  const isValid =
    Math.abs(remainder) < 0.01 &&
    splitLines.length >= 2 &&
    // Allow negative amounts (e.g. a refund within the same transaction).
    // Require only that each line is non-zero and has a category.
    splitLines.every((l) => l.category !== '' && (parseFloat(l.outflow) || 0) !== 0);

  const filteredCats = useMemo(() => {
    if (!catFilter) return categories;
    const q = catFilter.toLowerCase();
    return categories.filter((c) => c.category.toLowerCase().includes(q));
  }, [categories, catFilter]);

  function updateLine(key: string, patch: Partial<SplitLine>) {
    setSplitLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
    setError(null);
  }

  function removeLine(key: string) {
    setSplitLines((prev) => prev.filter((l) => l._key !== key));
  }

  function addLine() {
    setSplitLines((prev) => [...prev, makeLine(parent.payee)]);
  }

  function openPicker(key: string) {
    setOpenCatKey(key);
    setCatFilter('');
  }

  function selectCategory(key: string, cat: string) {
    updateLine(key, { category: cat });
    setOpenCatKey(null);
    setCatFilter('');
  }

  function handleSetRemaining(key: string) {
    const lineAmount = parseFloat(splitLines.find((l) => l._key === key)?.outflow ?? '0') || 0;
    const newAmount = Math.round((lineAmount + remainder) * 100) / 100;
    if (newAmount > 0) updateLine(key, { outflow: String(newAmount) });
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      const splits = splitLines.map((l) => {
        const cat = categories.find((c) => c.category === l.category);
        return {
          payee: l.payee,
          category: l.category,
          category_group: cat?.category_group ?? '',
          category_subgroup: cat?.category_subgroup ?? '',
          category_type: cat?.category_type ?? '',
          amount: -(parseFloat(l.outflow) || 0),
          _childId: l._childId,
          _childRowIndex: l._childRowIndex,
        };
      });

      if (isEditMode) {
        await optimisticEditSplitChildren(parent, existingChildren, splits, client);
      } else {
        await optimisticSplitTransaction(parent, splits, client);
      }
      onSaved();
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Save failed. Check your connection and try again.');
      setSaving(false);
    }
  }

  const totalClass = Math.abs(remainder) < 0.01
    ? 'split-total-valid'
    : splitTotal > parentOutflow
      ? 'split-total-over'
      : 'split-total-under';

  const formContent = (
    <div className="split-editor-content">
      {splitLines.map((line, index) => (
        <div key={line._key} className="split-line">
          <div className="split-line-row">
            {/* Payee — wrapper div is the flex item so width:100% on input works */}
            <div className="split-line-payee-wrap">
              <input
                className="tx-edit-input"
                placeholder="Payee"
                value={line.payee}
                onChange={(e) => updateLine(line._key, { payee: e.target.value })}
              />
            </div>
            {/* Amount + "set remaining" */}
            <div className="split-line-amount-wrap">
              <input
                data-testid={`split-amount-${index}`}
                className="tx-edit-input"
                type="number"
                step="0.01"
                placeholder="0.00"
                value={line.outflow}
                onChange={(e) => updateLine(line._key, { outflow: e.target.value })}
              />
              {Math.abs(remainder) >= 0.01 && (
                <button
                  className="split-line-fill-btn"
                  title={`Set to remaining (${fmt(remainder > 0 ? remainder : 0)})`}
                  onClick={() => handleSetRemaining(line._key)}
                  disabled={remainder <= 0}
                >
                  ↓
                </button>
              )}
            </div>
            {/* Remove — only for new (non-existing) lines */}
            {!line._childId && splitLines.length > 2 && (
              <button
                data-testid="remove-split-row-btn"
                className="split-line-remove"
                onClick={() => removeLine(line._key)}
                title="Remove this split"
              >
                ×
              </button>
            )}
          </div>

          {/* Category picker */}
          <button
            data-testid={`split-category-${index}`}
            className={`split-line-cat-btn${line.category ? ' split-line-cat-btn--selected' : ''}`}
            onClick={() => (openCatKey === line._key ? setOpenCatKey(null) : openPicker(line._key))}
          >
            {line.category || 'Pick category…'}
          </button>
          {openCatKey === line._key && (
            <>
              <input
                className="tx-edit-cat-filter"
                placeholder="Search categories…"
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                autoFocus
              />
              <div className="tx-edit-cat-list split-cat-list">
                {filteredCats.length === 0 ? (
                  <div className="tx-edit-cat-none">No categories match.</div>
                ) : (
                  filteredCats.map((cat) => (
                    <button
                      key={cat.category}
                      className={`tx-edit-cat-item${line.category === cat.category ? ' tx-edit-cat-item--selected' : ''}`}
                      onClick={() => selectCategory(line._key, cat.category)}
                    >
                      {cat.category}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ))}

      <button data-testid="add-split-row-btn" className="split-add-btn" onClick={addLine}>
        + Add split line
      </button>

      <div data-testid="split-total-indicator" className="split-total-row">
        <span>Total: {fmt(splitTotal)} of {fmt(parentOutflow)}</span>
        <span data-testid="split-remaining-indicator" className={totalClass}>
          {Math.abs(remainder) < 0.01
            ? 'Balanced ✓'
            : remainder > 0
              ? `${fmt(remainder)} remaining`
              : `${fmt(-remainder)} over`}
        </span>
      </div>

      {error && <div className="tx-edit-error">{error}</div>}
      <div className="tx-edit-actions">
        <button
          data-testid="cancel-splits-btn"
          className="btn-secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          data-testid="save-splits-btn"
          className="btn-primary"
          onClick={handleSave}
          disabled={!isValid || saving}
        >
          {saving ? 'Saving…' : isEditMode ? 'Update splits' : 'Save splits'}
        </button>
      </div>
    </div>
  );

  if (isDesktop) {
    return <div className="tx-edit-inline split-editor">{formContent}</div>;
  }

  return (
    <div className="assign-overlay" onClick={onClose}>
      <div className="assign-sheet tx-detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="assign-sheet-handle" />
        <div className="tx-detail-hero">
          <span className="tx-detail-amount tx-amount--outflow">-{fmt(parentOutflow)}</span>
          <span className="tx-detail-payee">{parent.payee || parent.description || '(unknown payee)'}</span>
          <span className="tx-detail-date">{isEditMode ? 'Edit split' : 'Split transaction'}</span>
        </div>
        {formContent}
      </div>
    </div>
  );
}
