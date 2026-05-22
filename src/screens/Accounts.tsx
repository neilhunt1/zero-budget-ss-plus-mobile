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
import SearchBar, { type ActiveFilter } from '../components/SearchBar';
import { Transaction } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RECENT_DAYS = 90;

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

// ─── Transaction detail bottom sheet ──────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

function TxDetailSheet({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const isInflow = tx.inflow > 0;
  const amount = isInflow ? fmt(tx.inflow) : fmt(tx.outflow);
  const amountDisplay = `${isInflow ? '+' : '-'}${amount}`;

  return (
    <div className="assign-overlay" onClick={onClose}>
      <div className="assign-sheet tx-detail-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="assign-sheet-handle" />
        <div className="tx-detail-hero">
          <span className={`tx-detail-amount${isInflow ? ' tx-amount--inflow' : ' tx-amount--outflow'}`}>
            {amountDisplay}
          </span>
          <span className="tx-detail-payee">{tx.payee || tx.description || '(unknown payee)'}</span>
          <span className="tx-detail-date">{tx.date}</span>
        </div>
        <div className="detail-section">
          <DetailRow label="Account" value={tx.account} />
          <DetailRow label="Category" value={tx.category || 'Uncategorized'} />
          <DetailRow label="Category Group" value={tx.category_group} />
          <DetailRow label="Status" value={tx.status} />
          <DetailRow label="Reviewed" value={tx.reviewed ? 'Yes' : 'No'} />
          <DetailRow label="Type" value={tx.transaction_type} />
          <DetailRow label="Source" value={tx.source} />
          <DetailRow label="Memo" value={tx.memo} />
          {tx.needs_reimbursement && <DetailRow label="Needs Reimbursement" value="Yes" />}
          <DetailRow label="Transaction ID" value={tx.transaction_id} />
        </div>
        <button className="picker-cancel" onClick={onClose}>Close</button>
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
            displayedTransactions.map((tx) => (
              <button
                key={tx.transaction_id}
                className={txRowClass(tx)}
                onClick={() => setSelectedTx(tx)}
              >
                <div className="tx-row-main">
                  <span className="tx-payee">
                    {tx.payee || tx.description || '(unknown)'}
                    {tx.parent_id && <span className="tx-split-label"> (split)</span>}
                  </span>
                  <span className="tx-meta">
                    {tx.account} · {tx.status === 'pending' ? '⏳ ' : ''}{tx.date}
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
            ))
          )}
        </div>
      )}

      {selectedTx && (
        <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />
      )}
    </div>
  );
}
