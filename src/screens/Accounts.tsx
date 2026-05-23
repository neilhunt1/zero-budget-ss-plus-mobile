import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getRecentTransactions,
  searchTransactions,
  getTransactionsByCategory,
  getTransactionsByAccount,
  getTransactionsByPayee,
} from '../db/queries';
import { db } from '../db/schema';
import SearchBar, { type ActiveFilter } from '../components/SearchBar';
import { Transaction, BudgetCategory, TransactionStatus } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { SheetsClient } from '../api/client';
import { optimisticEditTransaction } from '../db/optimisticWrites';
import { getAccountDisplayName } from '../utils/accountNames';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RECENT_DAYS = 90;
const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

// pending takes priority over unreviewed since it's a bank-level status
export function txRowClass(tx: Transaction): string {
  if (tx.status === 'pending') return 'tx-row tx-row--pending';
  if (!tx.reviewed) return 'tx-row tx-row--unreviewed';
  return 'tx-row';
}

type FilterMode = 'all' | 'unreviewed' | 'pending';

function fmtDate(iso: string): string {
  // Append time to avoid timezone-shift to previous day
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function txDesktopRowClass(tx: Transaction, selected: boolean): string {
  const parts = ['tx-row-desktop'];
  if (tx.status === 'pending') parts.push('tx-row--pending');
  else if (!tx.reviewed) parts.push('tx-row--unreviewed');
  if (selected) parts.push('tx-row--selected');
  return parts.join(' ');
}

// ─── Editable transaction detail ───────────────────────────────────────────────

type FormState = {
  payee: string;
  category: string;
  memo: string;
  outflow: string;
  inflow: string;
  date: string;
  account: string;
  status: TransactionStatus;
  reviewed: boolean;
};

function initForm(tx: Transaction): FormState {
  return {
    payee: tx.payee,
    category: tx.category,
    memo: tx.memo,
    outflow: tx.outflow > 0 ? String(tx.outflow) : '',
    inflow: tx.inflow > 0 ? String(tx.inflow) : '',
    date: tx.date,
    account: tx.account,
    status: tx.status,
    reviewed: tx.reviewed,
  };
}

function buildDiff(
  tx: Transaction,
  form: FormState,
  catRecord: BudgetCategory | undefined
): Partial<Transaction> {
  const changes: Partial<Transaction> = {};
  if (form.payee !== tx.payee) changes.payee = form.payee;
  if (form.category !== tx.category) {
    changes.category = form.category;
    changes.category_group = catRecord?.category_group ?? '';
    changes.category_type = catRecord?.category_type ?? '';
  }
  if (form.memo !== tx.memo) changes.memo = form.memo;
  const outflow = parseFloat(form.outflow) || 0;
  const inflow = parseFloat(form.inflow) || 0;
  if (outflow !== tx.outflow) changes.outflow = outflow;
  if (inflow !== tx.inflow) changes.inflow = inflow;
  if (form.date !== tx.date) changes.date = form.date;
  if (form.account !== tx.account) changes.account = form.account;
  if (form.status !== tx.status) changes.status = form.status;
  if (form.reviewed !== tx.reviewed) changes.reviewed = form.reviewed;
  return changes;
}

function TxDetailEditor({
  tx,
  categories,
  onClose,
  isDesktop,
  token,
}: {
  tx: Transaction;
  categories: BudgetCategory[];
  onClose: () => void;
  isDesktop: boolean;
  token: string | null;
}) {
  const [form, setForm] = useState<FormState>(() => initForm(tx));
  const [catFilter, setCatFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-init form if a different transaction is opened
  useEffect(() => {
    setForm(initForm(tx));
    setCatFilter('');
    setError(null);
  }, [tx.transaction_id]);

  const filteredCats = useMemo(() => {
    if (!catFilter) return categories;
    const q = catFilter.toLowerCase();
    return categories.filter((c) => c.category.toLowerCase().includes(q));
  }, [categories, catFilter]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  }

  async function handleSave() {
    if (!token) return;
    const catRecord = categories.find((c) => c.category === form.category);
    const changes = buildDiff(tx, form, catRecord);
    if (!Object.keys(changes).length) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      await optimisticEditTransaction(tx, changes, new SheetsClient(SHEET_ID, token));
      onClose();
    } catch {
      setError('Save failed. Check your connection and try again.');
      setSaving(false);
    }
  }

  const formContent = (
    <>
      <div className="tx-edit-field">
        <label className="tx-edit-label">Payee</label>
        <input
          className="tx-edit-input"
          value={form.payee}
          onChange={(e) => setField('payee', e.target.value)}
        />
      </div>
      <div className="tx-edit-section-title">Category</div>
      <input
        className="tx-edit-cat-filter"
        placeholder="Search categories…"
        value={catFilter}
        onChange={(e) => setCatFilter(e.target.value)}
      />
      <div className="tx-edit-cat-list">
        {filteredCats.length === 0 ? (
          <div className="tx-edit-cat-none">No categories match.</div>
        ) : (
          filteredCats.map((cat) => (
            <button
              key={cat.category}
              className={`tx-edit-cat-item${form.category === cat.category ? ' tx-edit-cat-item--selected' : ''}`}
              onClick={() => setField('category', cat.category)}
            >
              {cat.category}
            </button>
          ))
        )}
      </div>
      <div className="tx-edit-section-title">Details</div>
      <div className="tx-edit-field">
        <label className="tx-edit-label">Memo</label>
        <input
          className="tx-edit-input"
          value={form.memo}
          onChange={(e) => setField('memo', e.target.value)}
        />
      </div>
      <div className="tx-edit-amount-row">
        <div className="tx-edit-field">
          <label className="tx-edit-label">Outflow</label>
          <input
            className="tx-edit-input"
            type="number"
            min="0"
            step="0.01"
            value={form.outflow}
            onChange={(e) => {
              const val = e.target.value;
              setForm((f) => ({ ...f, outflow: val, ...(parseFloat(val) > 0 ? { inflow: '' } : {}) }));
              setError(null);
            }}
          />
        </div>
        <div className="tx-edit-field">
          <label className="tx-edit-label">Inflow</label>
          <input
            className="tx-edit-input"
            type="number"
            min="0"
            step="0.01"
            value={form.inflow}
            onChange={(e) => {
              const val = e.target.value;
              setForm((f) => ({ ...f, inflow: val, ...(parseFloat(val) > 0 ? { outflow: '' } : {}) }));
              setError(null);
            }}
          />
        </div>
      </div>
      <div className="tx-edit-field">
        <label className="tx-edit-label">Date</label>
        <input
          className="tx-edit-input"
          type="date"
          value={form.date}
          onChange={(e) => setField('date', e.target.value)}
        />
      </div>
      <div className="tx-edit-field">
        <label className="tx-edit-label">Account</label>
        <input
          className="tx-edit-input"
          value={form.account}
          onChange={(e) => setField('account', e.target.value)}
        />
      </div>
      <div className="tx-edit-field">
        <label className="tx-edit-label">Status</label>
        <select
          className="tx-edit-select"
          value={form.status}
          onChange={(e) => setField('status', e.target.value as TransactionStatus)}
        >
          <option value="cleared">Cleared</option>
          <option value="pending">Pending</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      <div className="tx-edit-toggle-row">
        <span className="tx-edit-toggle-label">Reviewed</span>
        <input
          type="checkbox"
          checked={form.reviewed}
          onChange={(e) => setField('reviewed', e.target.checked)}
        />
      </div>
      {error && <div className="tx-edit-error">{error}</div>}
      <div className="tx-edit-actions">
        <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );

  if (isDesktop) {
    return <div className="tx-edit-inline">{formContent}</div>;
  }

  return (
    <div className="assign-overlay" onClick={onClose}>
      <div className="assign-sheet tx-detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="assign-sheet-handle" />
        <div className="tx-detail-hero">
          <span className={`tx-detail-amount${tx.inflow > 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
            {tx.inflow > 0 ? `+${fmt(tx.inflow)}` : `-${fmt(tx.outflow)}`}
          </span>
          <span className="tx-detail-payee">{tx.payee || tx.description || '(unknown payee)'}</span>
          <span className="tx-detail-date">{tx.date}</span>
        </div>
        {formContent}
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'pending', label: 'Pending' },
];

export default function Accounts({ unreviewedCount }: { unreviewedCount: number | null }) {
  const navigate = useNavigate();
  const { token } = useAuth();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter | null>(null);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  // Debounce rawQuery → debouncedQuery (150ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 150);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const baseTransactions = useLiveQuery(
    () => {
      if (activeFilter?.type === 'category') {
        return getTransactionsByCategory(activeFilter.value);
      }
      if (activeFilter?.type === 'account') {
        return getTransactionsByAccount(activeFilter.value, debouncedQuery || undefined);
      }
      if (activeFilter?.type === 'payee') {
        return getTransactionsByPayee(activeFilter.value);
      }
      if (debouncedQuery) return searchTransactions(debouncedQuery);
      return getRecentTransactions(RECENT_DAYS);
    },
    [activeFilter, debouncedQuery]
  );

  const categories = useLiveQuery(
    () => db.budgetCategories.filter((c) => c.active).sortBy('sort_order'),
    []
  ) ?? [];

  // For category filter + text narrowing: client-side filter since getTransactionsByCategory returns all
  const filteredBySearch = useMemo(() => {
    if (!baseTransactions) return baseTransactions;
    if (activeFilter?.type === 'category' && debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      return baseTransactions.filter(
        (t) =>
          t.payee?.toLowerCase().includes(q) ||
          t.category?.toLowerCase().includes(q) ||
          t.memo?.toLowerCase().includes(q)
      );
    }
    return baseTransactions;
  }, [baseTransactions, activeFilter, debouncedQuery]);

  const loading = filteredBySearch === undefined;

  const displayedTransactions = useMemo(() => {
    let txns = filteredBySearch ?? [];
    if (filter === 'unreviewed') txns = txns.filter((t) => !t.reviewed);
    if (filter === 'pending') txns = txns.filter((t) => t.status === 'pending');
    return txns;
  }, [filteredBySearch, filter]);

  function handleSelectCategory(cat: string) {
    setActiveFilter({ type: 'category', value: cat });
    setRawQuery('');
    setDebouncedQuery('');
  }

  function handleSelectAccount(acct: string) {
    setActiveFilter({ type: 'account', value: acct });
    setRawQuery('');
    setDebouncedQuery('');
  }

  function handleSelectPayee(payee: string) {
    setActiveFilter({ type: 'payee', value: payee });
    setRawQuery('');
    setDebouncedQuery('');
  }

  function handleSelectFreeText(query: string) {
    setRawQuery(query);
    setDebouncedQuery(query);
  }

  function handleClear() {
    setRawQuery('');
    setDebouncedQuery('');
    setActiveFilter(null);
  }

  function scopeHint(): string {
    const count = filteredBySearch?.length ?? '…';
    if (activeFilter) {
      return `${activeFilter.value} — ${count} transaction${filteredBySearch?.length !== 1 ? 's' : ''}`;
    }
    if (debouncedQuery) {
      return `${count} result${filteredBySearch?.length !== 1 ? 's' : ''} across all history`;
    }
    return `Last ${RECENT_DAYS} days · search to see all history`;
  }

  const handleClose = () => setSelectedTx(null);

  return (
    <div className="screen transactions-screen">
      <header className="screen-header">
        <h2 className="screen-title">Transactions</h2>
      </header>

      {unreviewedCount != null && unreviewedCount > 0 && (
        <button className="triage-banner" onClick={() => navigate('/triage')}>
          {unreviewedCount} transaction{unreviewedCount !== 1 ? 's' : ''} need categories → Triage
        </button>
      )}

      <div className="tx-search-wrap">
        <SearchBar
          rawQuery={rawQuery}
          onChange={setRawQuery}
          activeFilter={activeFilter}
          onSelectCategory={handleSelectCategory}
          onSelectAccount={handleSelectAccount}
          onSelectPayee={handleSelectPayee}
          onSelectFreeText={handleSelectFreeText}
          onClear={handleClear}
        />
      </div>

      <div className="filter-chips" role="group" aria-label="Filter transactions">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            className={`filter-chip${filter === key ? ' filter-chip--active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="tx-list-scope">{scopeHint()}</div>

      {loading && <div className="state-msg">Loading…</div>}

      {!loading && (
        <div className="tx-list">
          {displayedTransactions.length === 0 ? (
            <div className="state-msg">No transactions in this view.</div>
          ) : (
            <>
              {/* Column headers — desktop only (hidden on mobile via CSS grid not applying) */}
              {isDesktop && (
                <div className="tx-list-header tx-desktop-cols" aria-hidden="true">
                  <span>Date</span>
                  <span>Account</span>
                  <span>Payee</span>
                  <span>Category</span>
                  <span>Memo</span>
                  <span className="tx-hdr-num">Outflow</span>
                  <span className="tx-hdr-num">Inflow</span>
                  <span />
                </div>
              )}
              {displayedTransactions.map((tx) => {
                const isSelected = selectedTx?.transaction_id === tx.transaction_id;
                const acct = getAccountDisplayName(tx.account);
                return (
                  <div key={tx.transaction_id}>
                    {isDesktop ? (
                      /* ── Desktop: single condensed grid row ── */
                      <button
                        className={txDesktopRowClass(tx, isSelected)}
                        onClick={() => setSelectedTx(isSelected ? null : tx)}
                        title={tx.memo || undefined}
                      >
                        <div className="tx-desktop-cols">
                          <span className="tx-desktop-cell tx-desktop-cell--secondary">{fmtDate(tx.date)}</span>
                          <span className="tx-desktop-cell tx-desktop-cell--secondary" title={tx.account}>{acct}</span>
                          <span className="tx-desktop-cell tx-desktop-cell--payee">
                            {tx.payee || tx.description || '(unknown)'}
                            {tx.parent_id && <span className="tx-split-label"> (split)</span>}
                          </span>
                          <span className={`tx-desktop-cell${!tx.category ? ' tx-desktop-cell--cat-none' : ''}`}>
                            {tx.reviewed && tx.category && <span className="tx-reviewed-mark" aria-hidden="true">✓ </span>}
                            {tx.category || 'Uncategorized'}
                          </span>
                          <span className="tx-desktop-cell tx-desktop-cell--secondary">{tx.memo}</span>
                          <span className={`tx-desktop-cell tx-desktop-cell--num${tx.outflow > 0 ? ' tx-desktop-cell--outflow' : ''}`}>
                            {tx.outflow > 0 ? fmt(tx.outflow) : ''}
                          </span>
                          <span className={`tx-desktop-cell tx-desktop-cell--num${tx.inflow > 0 ? ' tx-desktop-cell--inflow' : ''}`}>
                            {tx.inflow > 0 ? fmt(tx.inflow) : ''}
                          </span>
                          <span className={`tx-desktop-cell tx-desktop-cell--status${tx.status === 'cleared' ? ' cleared' : ''}`}>
                            {tx.status === 'cleared' ? '✓' : tx.status === 'pending' ? '○' : ''}
                          </span>
                        </div>
                      </button>
                    ) : (
                      /* ── Mobile: original card-style row ── */
                      <button
                        className={txRowClass(tx)}
                        onClick={() => setSelectedTx(isSelected ? null : tx)}
                      >
                        <div className="tx-row-main">
                          <span className="tx-payee">
                            {tx.payee || tx.description || '(unknown)'}
                            {tx.parent_id && <span className="tx-split-label"> (split)</span>}
                          </span>
                          <span className="tx-meta">
                            {acct} · {tx.status === 'pending' ? '⏳ ' : ''}{tx.date}
                          </span>
                          <span className={`tx-category${!tx.category ? ' tx-category--none' : ''}`}>
                            {tx.reviewed && tx.category && (
                              <span className="tx-reviewed-mark" aria-hidden="true">✓ </span>
                            )}
                            {tx.category || 'Uncategorized'}
                          </span>
                        </div>
                        <span className={`tx-amount${tx.inflow > 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
                          {tx.inflow > 0 ? `+${fmt(tx.inflow)}` : `-${fmt(tx.outflow)}`}
                        </span>
                      </button>
                    )}
                    {isSelected && isDesktop && (
                      <TxDetailEditor
                        tx={selectedTx!}
                        categories={categories}
                        onClose={handleClose}
                        isDesktop={true}
                        token={token}
                      />
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {selectedTx && !isDesktop && (
        <TxDetailEditor
          tx={selectedTx}
          categories={categories}
          onClose={handleClose}
          isDesktop={false}
          token={token}
        />
      )}
    </div>
  );
}
