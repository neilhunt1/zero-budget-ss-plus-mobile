import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
import { Transaction, BudgetCategory, TransactionStatus, TransactionType } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { SheetsClient, AuthError } from '../api/client';
import { optimisticEditTransaction, optimisticConfirmTransfer } from '../db/optimisticWrites';
import SplitEditor from '../components/SplitEditor';
import { classifyTransactionType, findTransferPair, findCcPaymentPair } from '../api/transactions';
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
  transaction_type: TransactionType | '';
  category: string;
  memo: string;
  amount: string;
  date: string;
  account: string;
  status: TransactionStatus;
  reviewed: boolean;
};

function initForm(tx: Transaction): FormState {
  return {
    payee: tx.payee,
    transaction_type: classifyTransactionType(tx),
    category: tx.category,
    memo: tx.memo,
    amount: String(tx.amount),
    date: tx.date,
    account: tx.account,
    status: tx.status,
    reviewed: tx.reviewed,
  };
}

const TX_TYPES: { value: TransactionType; label: string }[] = [
  { value: 'income',         label: '💰 Income'      },
  { value: 'regular',        label: '🛒 Regular'     },
  { value: 'transfer',       label: '↔️ Transfer'    },
  { value: 'credit_payment', label: '💳 CC Payment'  },
];

function buildDiff(
  tx: Transaction,
  form: FormState,
  catRecord: BudgetCategory | undefined
): Partial<Transaction> {
  const changes: Partial<Transaction> = {};
  if (form.payee !== tx.payee) changes.payee = form.payee;
  // transaction_type: compare against the normalised effective type
  const effectiveType = classifyTransactionType(tx);
  if (form.transaction_type && form.transaction_type !== effectiveType) {
    changes.transaction_type = form.transaction_type;
    // Clear category when reclassifying away from regular
    if (form.transaction_type !== 'regular') {
      changes.category = '';
      changes.category_group = '';
      changes.category_type = '';
    }
  }
  if (form.category !== tx.category) {
    changes.category = form.category;
    changes.category_group = catRecord?.category_group ?? '';
    changes.category_type = catRecord?.category_type ?? '';
  }
  if (form.memo !== tx.memo) changes.memo = form.memo;
  const amount = parseFloat(form.amount) || 0;
  if (amount !== tx.amount) changes.amount = amount;
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
  onSplit,
  splitChildren,
}: {
  tx: Transaction;
  categories: BudgetCategory[];
  onClose: () => void;
  isDesktop: boolean;
  token: string | null;
  onSplit?: () => void;
  /** Existing split children — when present, shows split summary instead of category picker. */
  splitChildren?: Transaction[];
}) {
  const { notifySessionExpired } = useAuth();
  const [form, setForm] = useState<FormState>(() => initForm(tx));
  const [catFilter, setCatFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pair-finder state (for orphaned transfer/cc_payment transactions)
  const allTxns = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const [pairCandidate, setPairCandidate] = useState<Transaction | null | 'not_found'>(null);
  const [linkingPair, setLinkingPair] = useState(false);

  // Re-init form if a different transaction is opened
  useEffect(() => {
    setForm(initForm(tx));
    setCatFilter('');
    setError(null);
    setPairCandidate(null);
    setLinkingPair(false);
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
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Save failed. Check your connection and try again.');
      setSaving(false);
    }
  }

  function handleFindPair() {
    const found =
      form.transaction_type === 'credit_payment'
        ? findCcPaymentPair(tx, allTxns)
        : findTransferPair(tx, allTxns);
    setPairCandidate(found ?? 'not_found');
  }

  async function handleLinkPair() {
    if (!token || !pairCandidate || pairCandidate === 'not_found') return;
    setLinkingPair(true);
    setError(null);
    try {
      await optimisticConfirmTransfer(
        tx,
        pairCandidate,
        new SheetsClient(SHEET_ID, token),
        form.transaction_type as TransactionType
      );
      onClose();
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Link failed. Check your connection and try again.');
      setLinkingPair(false);
    }
  }

  async function handleUnlink() {
    if (!token) return;
    setLinkingPair(true);
    setError(null);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      const pairedTx = allTxns.find((t) => t.transaction_id === tx.transfer_pair_id);
      await optimisticEditTransaction(tx, { transfer_pair_id: '' }, client);
      if (pairedTx) {
        await optimisticEditTransaction(pairedTx, { transfer_pair_id: '' }, client);
      }
      onClose();
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Unlink failed. Check your connection and try again.');
      setLinkingPair(false);
    }
  }

  const formContent = (
    <>
      {/* Type selector — income / regular / transfer */}
      <div className="tx-edit-type-row">
        {TX_TYPES.map(({ value, label }) => (
          <button
            key={value}
            className={`tx-edit-type-pill${form.transaction_type === value ? ' tx-edit-type-pill--active' : ''}`}
            onClick={() => {
              setForm((f) => ({
                ...f,
                transaction_type: value,
                // clear category when switching away from regular
                ...(value !== 'regular' ? { category: '' } : {}),
              }));
              setError(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Row 1: Payee | Memo — both short free-text, share the width */}
      <div className="tx-edit-2col">
        <div className="tx-edit-field">
          <label className="tx-edit-label">Payee</label>
          <input
            className="tx-edit-input"
            value={form.payee}
            onChange={(e) => setField('payee', e.target.value)}
          />
        </div>
        <div className="tx-edit-field">
          <label className="tx-edit-label">Memo</label>
          <input
            className="tx-edit-input"
            value={form.memo}
            onChange={(e) => setField('memo', e.target.value)}
          />
        </div>
      </div>

      {/* Row 2: Category — only shown for regular purchases */}
      {form.transaction_type === 'regular' || form.transaction_type === '' ? (
        splitChildren && splitChildren.length > 0 ? (
          /* Already-split: show summary of existing children */
          <>
            <div className="tx-edit-section-title-row">
              <span className="tx-edit-section-title">Split</span>
              {onSplit && (
                <button data-testid="split-transaction-btn" className="btn-ghost btn-ghost--sm" onClick={onSplit} disabled={saving}>
                  Modify splits
                </button>
              )}
            </div>
            <div className="tx-edit-split-summary">
              {splitChildren.map((child) => (
                <div key={child.transaction_id} className="tx-edit-split-row">
                  <span className="tx-edit-split-payee">{child.payee || tx.payee}</span>
                  <span className="tx-edit-split-cat">{child.category}</span>
                  <span className="tx-edit-split-amt">{fmt(Math.abs(child.amount))}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* Normal: category picker with Split button in header */
          <>
            <div className="tx-edit-section-title-row">
              <span className="tx-edit-section-title">Category</span>
              {onSplit && (
                <button data-testid="split-transaction-btn" className="btn-ghost btn-ghost--sm" onClick={onSplit} disabled={saving}>
                  Split
                </button>
              )}
            </div>
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
          </>
        )
      ) : (
        <>
          <div className="tx-edit-type-note">
            {form.transaction_type === 'income'
              ? '💰 Income transactions don\'t have a category.'
              : form.transaction_type === 'credit_payment'
              ? '💳 CC Payment transactions don\'t have a category.'
              : '↔️ Transfer transactions don\'t have a category.'}
          </div>

          {/* Pair linking — for transfer / cc_payment: link, unlink, or find */}
          {(form.transaction_type === 'transfer' || form.transaction_type === 'credit_payment') && (
            <div className="tx-edit-pair-finder">
              {tx.transfer_pair_id ? (
                /* Already linked — show paired account with unlink option */
                <div className="tx-edit-pair-result tx-edit-pair-result--linked">
                  <span className="tx-edit-pair-label">
                    Paired with: {getAccountDisplayName(
                      allTxns.find((t) => t.transaction_id === tx.transfer_pair_id)?.account ?? ''
                    ) || '(unknown)'}
                  </span>
                  <button className="btn btn-ghost" onClick={handleUnlink} disabled={linkingPair}>
                    {linkingPair ? 'Unlinking…' : '🔗 Unlink pair'}
                  </button>
                </div>
              ) : pairCandidate === null ? (
                <button className="btn btn-secondary" onClick={handleFindPair}>
                  🔍 Find matching pair
                </button>
              ) : pairCandidate === 'not_found' ? (
                <div className="tx-edit-pair-result tx-edit-pair-result--none">
                  No matching pair found
                  <button className="btn btn-ghost" onClick={handleFindPair}>Try again</button>
                </div>
              ) : (
                <div className="tx-edit-pair-result tx-edit-pair-result--found">
                  <span className="tx-edit-pair-label">
                    Found: {getAccountDisplayName(pairCandidate.account)} · {pairCandidate.date}
                    · {pairCandidate.amount < 0 ? `-${fmt(-pairCandidate.amount)}` : `+${fmt(pairCandidate.amount)}`}
                  </span>
                  <button className="btn btn-primary" onClick={handleLinkPair} disabled={linkingPair}>
                    {linkingPair ? 'Linking…' : 'Link them'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Row 3: Outflow | Inflow */}
      <div className="tx-edit-amount-row">
        <div className="tx-edit-field">
          <label className="tx-edit-label">Amount</label>
          <input
            className="tx-edit-input"
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(e) => { setField('amount', e.target.value); }}
          />
        </div>
      </div>

      {/* Row 4: Date | Account | Status | Reviewed — all metadata, one line */}
      <div className="tx-edit-meta-row">
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
        <div className="tx-edit-field tx-edit-field--shrink">
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
        <div className="tx-edit-field tx-edit-field--shrink tx-edit-field--center">
          <label className="tx-edit-label">Reviewed</label>
          <input
            type="checkbox"
            className="tx-edit-checkbox"
            checked={form.reviewed}
            onChange={(e) => setField('reviewed', e.target.checked)}
          />
        </div>
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
    return <div className="tx-edit-inline" data-testid="tx-detail">{formContent}</div>;
  }

  return (
    <div className="assign-overlay" onClick={onClose}>
      <div className="assign-sheet tx-detail-sheet" data-testid="tx-detail" onClick={(e) => e.stopPropagation()}>
        <div className="assign-sheet-handle" />
        <div className="tx-detail-hero">
          <span className={`tx-detail-amount${tx.amount >= 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
            {tx.amount >= 0 ? `+${fmt(tx.amount)}` : `-${fmt(-tx.amount)}`}
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

export default function Accounts() {
  const location = useLocation();
  const { token } = useAuth();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter | null>(null);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);
  const [splitEditChildren, setSplitEditChildren] = useState<Transaction[]>([]);
  const [expandedPairIds, setExpandedPairIds] = useState<Set<string>>(new Set());
  const [expandedSplitIds, setExpandedSplitIds] = useState<Set<string>>(new Set());
  const highlightId = (location.state as { highlightId?: string } | null)?.highlightId ?? null;

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

  const allSplitChildren = useLiveQuery(
    () => db.transactions.where('parent_id').notEqual('').toArray(),
    []
  ) ?? [];

  const splitChildrenMap = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const child of allSplitChildren) {
      const siblings = map.get(child.parent_id) ?? [];
      siblings.push(child);
      map.set(child.parent_id, siblings);
    }
    return map;
  }, [allSplitChildren]);

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

  // Auto-select a transaction navigated to from Triage's "View in list" link
  useEffect(() => {
    if (!highlightId || !baseTransactions) return;
    const tx = baseTransactions.find((t) => t.transaction_id === highlightId);
    if (tx) setSelectedTx(tx);
  }, [highlightId, baseTransactions]);

  const loading = filteredBySearch === undefined;

  const displayedTransactions = useMemo(() => {
    let txns = filteredBySearch ?? [];
    if (filter === 'unreviewed') txns = txns.filter((t) => !t.reviewed);
    if (filter === 'pending') txns = txns.filter((t) => t.status === 'pending');
    return txns;
  }, [filteredBySearch, filter]);

  // Collapse transfer/cc-payment pairs into a single primary row.
  // Primary = the outflow leg (or the first encountered when both are inflow-only).
  // Only collapse when the link is mutual (both legs point to each other) to avoid
  // showing the wrong pair if stale/one-directional transfer_pair_id data exists.
  const { visibleRows, pairMap } = useMemo(() => {
    const byId = new Map(displayedTransactions.map((t) => [t.transaction_id, t]));
    const suppressed = new Set<string>(); // secondary legs — hidden entirely
    const processed = new Set<string>();  // primaries already in visibleRows
    const pairMap = new Map<string, Transaction>(); // primary_id → secondary tx
    const visibleRows: Transaction[] = [];

    for (const tx of displayedTransactions) {
      if (suppressed.has(tx.transaction_id) || processed.has(tx.transaction_id)) continue;
      const pairTx = tx.transfer_pair_id ? byId.get(tx.transfer_pair_id) : undefined;
      // Require mutual links: each leg must reference the other's ID
      const isMutual = pairTx?.transfer_pair_id === tx.transaction_id;
      if (pairTx && isMutual && !suppressed.has(pairTx.transaction_id) && !processed.has(pairTx.transaction_id)) {
        // Prefer the outflow leg as primary
        const [primary, secondary] = Math.abs(tx.amount) >= Math.abs(pairTx.amount) ? [tx, pairTx] : [pairTx, tx];
        suppressed.add(secondary.transaction_id);
        processed.add(primary.transaction_id);
        pairMap.set(primary.transaction_id, secondary);
        visibleRows.push(primary);
      } else {
        processed.add(tx.transaction_id);
        visibleRows.push(tx);
      }
    }
    return { visibleRows, pairMap };
  }, [displayedTransactions]);

  // Transactions classified as transfer/cc_payment, reviewed, older than 7 days, no pair.
  const unmatchedTransferCount = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return (filteredBySearch ?? []).filter(
      (t) =>
        (t.transaction_type === 'transfer' || t.transaction_type === 'credit_payment') &&
        t.reviewed &&
        !t.transfer_pair_id &&
        t.date < cutoffStr
    ).length;
  }, [filteredBySearch]);

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

  const handleClose = () => { setSelectedTx(null); setSplitTx(null); setSplitEditChildren([]); };

  /** True when the transaction can be split for the first time. */
  const canSplit = (tx: Transaction) => tx.amount < 0 && !tx.split_group_id;

  /** True when an already-split transaction can have its splits edited. */
  const canEditSplit = (tx: Transaction) =>
    tx.amount < 0 && !!tx.split_group_id && splitChildrenMap.has(tx.transaction_id);

  /** Opens SplitEditor for new or existing split. */
  function handleSplit(tx: Transaction) {
    setSplitTx(tx);
    setSplitEditChildren(splitChildrenMap.get(tx.transaction_id) ?? []);
  }

  return (
    <div className="screen transactions-screen" data-testid="accounts-screen">
      <header className="screen-header">
        <h2 className="screen-title">Transactions</h2>
      </header>

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

      {unmatchedTransferCount > 0 && (
        <div className="unmatched-transfer-warning">
          ⚠️ {unmatchedTransferCount} transfer{unmatchedTransferCount !== 1 ? 's' : ''} older than 7 days have no matching pair
        </div>
      )}

      {loading && <div className="state-msg">Loading…</div>}

      {!loading && (
        <div className="tx-list" data-testid="tx-list">
          {visibleRows.length === 0 ? (
            <div className="state-msg">No transactions in this view.</div>
          ) : (
            <>
              {/* Column headers — desktop only */}
              {isDesktop && (
                <div className="tx-list-header tx-desktop-cols" aria-hidden="true">
                  <span>Date</span>
                  <span>Account</span>
                  <span>Payee</span>
                  <span>Category</span>
                  <span>Memo</span>
                  <span className="tx-hdr-num">Amount</span>
                  <span className="tx-hdr-icon" title="Transaction type">⊕</span>
                  <span className="tx-hdr-icon" title="Reviewed">✓</span>
                  <span className="tx-hdr-icon" title="Cleared">C</span>
                </div>
              )}
              {visibleRows.map((tx) => {
                const isSelected = selectedTx?.transaction_id === tx.transaction_id;
                const acct = getAccountDisplayName(tx.account);
                const txType = classifyTransactionType(tx);
                const typeIcon = txType === 'income' ? '💰'
                  : txType === 'transfer' ? '↔️'
                  : txType === 'credit_payment' ? '💳'
                  : txType === 'regular' ? '🛒'
                  : '';
                const pairTx = pairMap.get(tx.transaction_id);
                const isExpanded = expandedPairIds.has(tx.transaction_id);

                function togglePair() {
                  setExpandedPairIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(tx.transaction_id)) next.delete(tx.transaction_id);
                    else next.add(tx.transaction_id);
                    return next;
                  });
                }

                return (
                  <div key={tx.transaction_id}>
                    {isDesktop ? (
                      /* ── Desktop: single condensed grid row ── */
                      <>
                        <button
                          className={txDesktopRowClass(tx, isSelected)}
                          onClick={() => { setSelectedTx(isSelected ? null : tx); setSplitTx(null); setSplitEditChildren([]); }}
                          title={tx.memo || undefined}
                          data-testid="tx-row"
                          data-transaction-id={tx.transaction_id}
                        >
                          <div className="tx-desktop-cols">
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{fmtDate(tx.date)}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--secondary" title={tx.account}>{acct}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--payee">
                              {tx.payee || tx.description || '(unknown)'}
                              {tx.split_group_id && !tx.parent_id && <span className="tx-split-label"> (split)</span>}
                              {pairTx && (
                                <span className="tx-pair-label"> → {getAccountDisplayName(pairTx.account)}</span>
                              )}
                            </span>
                            <span className={`tx-desktop-cell${!tx.category && !tx.split_group_id ? ' tx-desktop-cell--cat-none' : ''}`}>
                              {tx.split_group_id && !tx.parent_id ? 'Split' : (tx.category || 'Uncategorized')}
                            </span>
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{tx.memo}</span>
                            <span className={`tx-desktop-cell tx-desktop-cell--num${tx.amount >= 0 ? ' tx-desktop-cell--inflow' : ' tx-desktop-cell--outflow'}`}>
                              {tx.amount >= 0 ? `+${fmt(tx.amount)}` : `-${fmt(-tx.amount)}`}
                            </span>
                            <span className="tx-desktop-cell tx-desktop-cell--icon" title={txType || 'unknown'}>
                              {typeIcon}
                            </span>
                            <span className="tx-desktop-cell tx-desktop-cell--icon">
                              {tx.reviewed && <span className="tx-rev-mark" aria-label="Reviewed">✓</span>}
                            </span>
                            <span className="tx-desktop-cell tx-desktop-cell--icon">
                              <span className={`tx-clr-icon${tx.status === 'cleared' ? ' tx-clr-icon--cleared' : tx.status === 'pending' ? ' tx-clr-icon--pending' : ''}`}>
                                {tx.status === 'pending' ? 'P' : 'C'}
                              </span>
                            </span>
                          </div>
                        </button>
                        {pairTx && (
                          <button className="tx-pair-toggle" onClick={togglePair} aria-label={isExpanded ? 'Collapse pair' : 'Expand pair'}>
                            {isExpanded ? '▲ Hide pair leg' : '▼ Show pair leg'}
                          </button>
                        )}
                        {pairTx && isExpanded && (
                          <div className="tx-pair-row tx-desktop-cols">
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{fmtDate(pairTx.date)}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{getAccountDisplayName(pairTx.account)}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--payee tx-desktop-cell--secondary">{pairTx.payee || pairTx.description || '(unknown)'}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{pairTx.category}</span>
                            <span className="tx-desktop-cell tx-desktop-cell--secondary">{pairTx.memo}</span>
                            <span className={`tx-desktop-cell tx-desktop-cell--num${pairTx.amount >= 0 ? ' tx-desktop-cell--inflow' : ' tx-desktop-cell--outflow'}`}>
                              {pairTx.amount >= 0 ? `+${fmt(pairTx.amount)}` : `-${fmt(-pairTx.amount)}`}
                            </span>
                            <span className="tx-desktop-cell" />
                            <span className="tx-desktop-cell" />
                            <span className="tx-desktop-cell" />
                          </div>
                        )}
                        {splitChildrenMap.has(tx.transaction_id) && (() => {
                          const splitChildren = splitChildrenMap.get(tx.transaction_id)!;
                          const isSplitExpanded = expandedSplitIds.has(tx.transaction_id);
                          return (
                            <>
                              <button
                                className="tx-split-toggle"
                                onClick={() => setExpandedSplitIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(tx.transaction_id)) next.delete(tx.transaction_id);
                                  else next.add(tx.transaction_id);
                                  return next;
                                })}
                              >
                                {isSplitExpanded ? `▲ Hide ${splitChildren.length} splits` : `▼ ${splitChildren.length} splits`}
                              </button>
                              {isSplitExpanded && splitChildren.map((child) => (
                                <div key={child.transaction_id} className="tx-split-child-row tx-desktop-cols">
                                  <span className="tx-desktop-cell tx-desktop-cell--secondary" />
                                  <span className="tx-desktop-cell tx-desktop-cell--secondary" />
                                  <span className="tx-desktop-cell tx-desktop-cell--payee tx-desktop-cell--secondary">{child.payee}</span>
                                  <span className="tx-desktop-cell">{child.category}</span>
                                  <span className="tx-desktop-cell tx-desktop-cell--secondary">{child.memo}</span>
                                  <span className={`tx-desktop-cell tx-desktop-cell--num${child.amount >= 0 ? ' tx-desktop-cell--inflow' : ' tx-desktop-cell--outflow'}`}>
                                    {child.amount >= 0 ? `+${fmt(child.amount)}` : `-${fmt(-child.amount)}`}
                                  </span>
                                  <span className="tx-desktop-cell" />
                                  <span className="tx-desktop-cell" />
                                  <span className="tx-desktop-cell" />
                                </div>
                              ))}
                            </>
                          );
                        })()}
                      </>
                    ) : (
                      /* ── Mobile: card-style row ── */
                      <>
                        <button
                          className={txRowClass(tx)}
                          onClick={() => { setSelectedTx(isSelected ? null : tx); setSplitTx(null); setSplitEditChildren([]); }}
                          data-testid="tx-row"
                          data-transaction-id={tx.transaction_id}
                        >
                          <div className="tx-row-main">
                            <span className="tx-payee">
                              {typeIcon && <span className="tx-type-icon">{typeIcon} </span>}
                              {tx.payee || tx.description || '(unknown)'}
                              {tx.split_group_id && !tx.parent_id && <span className="tx-split-label"> (split)</span>}
                              {pairTx && <span className="tx-pair-label"> → {getAccountDisplayName(pairTx.account)}</span>}
                            </span>
                            <span className="tx-meta">
                              {acct} · {tx.status === 'pending' ? '⏳ ' : ''}{tx.date}
                            </span>
                            <span className={`tx-category${!tx.category && !tx.split_group_id ? ' tx-category--none' : ''}`}>
                              {tx.reviewed && tx.category && (
                                <span className="tx-reviewed-mark" aria-hidden="true">✓ </span>
                              )}
                              {tx.split_group_id && !tx.parent_id ? 'Split' : (tx.category || 'Uncategorized')}
                            </span>
                          </div>
                          <span className={`tx-amount${tx.amount >= 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
                            {tx.amount >= 0 ? `+${fmt(tx.amount)}` : `-${fmt(-tx.amount)}`}
                          </span>
                        </button>
                        {pairTx && (
                          <button className="tx-pair-toggle" onClick={togglePair}>
                            {isExpanded ? '▲ Hide pair leg' : `▼ ${getAccountDisplayName(pairTx.account)}`}
                          </button>
                        )}
                        {pairTx && isExpanded && (
                          <div className="tx-pair-row">
                            <span className="tx-payee tx-desktop-cell--secondary">{getAccountDisplayName(pairTx.account)}</span>
                            <span className={`tx-amount${pairTx.amount >= 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
                              {pairTx.amount >= 0 ? `+${fmt(pairTx.amount)}` : `-${fmt(-pairTx.amount)}`}
                            </span>
                          </div>
                        )}
                        {splitChildrenMap.has(tx.transaction_id) && (() => {
                          const splitChildren = splitChildrenMap.get(tx.transaction_id)!;
                          const isSplitExpanded = expandedSplitIds.has(tx.transaction_id);
                          return (
                            <>
                              <button
                                className="tx-split-toggle"
                                onClick={() => setExpandedSplitIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(tx.transaction_id)) next.delete(tx.transaction_id);
                                  else next.add(tx.transaction_id);
                                  return next;
                                })}
                              >
                                {isSplitExpanded ? `▲ Hide ${splitChildren.length} splits` : `▼ ${splitChildren.length} splits`}
                              </button>
                              {isSplitExpanded && splitChildren.map((child) => (
                                <div key={child.transaction_id} className="tx-split-child-row">
                                  <span className="tx-payee tx-desktop-cell--secondary">{child.payee}</span>
                                  <span className={`tx-category${!child.category ? ' tx-category--none' : ''}`}>{child.category}</span>
                                  <span className={`tx-amount${child.amount >= 0 ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
                                    {child.amount >= 0 ? `+${fmt(child.amount)}` : `-${fmt(-child.amount)}`}
                                  </span>
                                </div>
                              ))}
                            </>
                          );
                        })()}
                      </>
                    )}
                    {isDesktop && (isSelected || splitTx?.transaction_id === tx.transaction_id) && (
                      splitTx?.transaction_id === tx.transaction_id
                        ? <SplitEditor
                            parent={splitTx}
                            categories={categories}
                            existingChildren={splitEditChildren}
                            onClose={() => { setSplitTx(null); setSplitEditChildren([]); }}
                            onSaved={splitEditChildren.length > 0
                              ? () => { setSplitTx(null); setSplitEditChildren([]); }
                              : handleClose}
                            isDesktop={true}
                            token={token}
                          />
                        : <TxDetailEditor
                            tx={selectedTx!}
                            categories={categories}
                            onClose={handleClose}
                            isDesktop={true}
                            token={token}
                            splitChildren={splitChildrenMap.get(tx.transaction_id)}
                            onSplit={canSplit(tx) || canEditSplit(tx) ? () => handleSplit(tx) : undefined}
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
          splitChildren={splitChildrenMap.get(selectedTx.transaction_id)}
          onSplit={canSplit(selectedTx) || canEditSplit(selectedTx) ? () => handleSplit(selectedTx) : undefined}
        />
      )}
      {splitTx && !isDesktop && (
        <SplitEditor
          parent={splitTx}
          categories={categories}
          existingChildren={splitEditChildren}
          onClose={() => { setSplitTx(null); setSplitEditChildren([]); }}
          onSaved={splitEditChildren.length > 0
            ? () => { setSplitTx(null); setSplitEditChildren([]); setSelectedTx(splitTx); }
            : handleClose}
          isDesktop={false}
          token={token}
        />
      )}
    </div>
  );
}
