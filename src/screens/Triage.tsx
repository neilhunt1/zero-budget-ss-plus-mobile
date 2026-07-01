import { useMemo, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '../hooks/useAuth';
import { SheetsClient, AuthError } from '../api/client';
import {
  classifyTransactionType,
  findTransferPair,
  findCcPaymentPair,
} from '../api/transactions';
import { getActiveBudgetCategories, getSuggestedCategory, getStaleManualCount, getUnknownAccountNames } from '../db/queries';
import {
  optimisticApproveIncome,
  optimisticConfirmTransfer,
  optimisticAssignPurchase,
} from '../db/optimisticWrites';
import { db } from '../db/schema';
import { Transaction, BudgetCategory, TransactionType } from '../types';

const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function txAmount(tx: Transaction): number {
  return tx.inflow > 0 ? tx.inflow : tx.outflow;
}

function txAmountLabel(tx: Transaction): string {
  const sign = tx.inflow > 0 ? '+' : '-';
  return `${sign}${fmt(txAmount(tx))}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function IncomeCard({
  tx,
  onApprove,
  onTypeOverride,
  onViewInList,
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  onApprove: () => void;
  onTypeOverride: (type: TransactionType) => void;
  onViewInList: () => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
}) {
  return (
    <div className="triage-card triage-card--income">
      <div className="triage-card-type">💰 Income</div>
      <div className="triage-card-amount triage-card-amount--positive">{txAmountLabel(tx)}</div>
      <div className="triage-card-payee">{tx.payee || tx.description || '(unknown payee)'}</div>
      <div className="triage-card-meta">
        <span>{tx.account}</span>
        <span>{fmtDate(tx.date)}</span>
      </div>
      <button className="triage-view-in-list" onClick={onViewInList}>View in list →</button>
      <div className="triage-actions">
        <button className="btn btn-primary" onClick={onApprove}>
          Approve
        </button>
      </div>
      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not income {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('transfer')}>↔️ Transfer</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('credit_payment')}>💳 CC Payment</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('regular')}>🛒 Purchase</button>
        </div>
      )}
    </div>
  );
}

function TransferCard({
  tx,
  pair,
  onConfirm,
  onTypeOverride,
  onViewInList,
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  pair: Transaction | null;
  onConfirm: () => void;
  onTypeOverride: (type: TransactionType) => void;
  onViewInList: () => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
}) {
  return (
    <div className="triage-card triage-card--transfer">
      <div className="triage-card-type">↔️ Transfer</div>
      <div className="triage-card-amount">{txAmountLabel(tx)}</div>
      <div className="triage-card-payee">{tx.payee || tx.description || '(unknown payee)'}</div>
      <div className="triage-card-meta">
        <span>{tx.account}</span>
        <span>{fmtDate(tx.date)}</span>
      </div>
      {pair && (
        <div className="triage-pair-match">Matched with {pair.account}</div>
      )}
      <button className="triage-view-in-list" onClick={onViewInList}>View in list →</button>
      <div className="triage-actions">
        <button className="btn btn-primary" onClick={onConfirm}>
          Confirm
        </button>
      </div>
      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not a transfer {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('income')}>💰 Income</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('credit_payment')}>💳 CC Payment</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('regular')}>🛒 Purchase</button>
        </div>
      )}
    </div>
  );
}

function CcPaymentCard({
  tx,
  pair,
  onConfirm,
  onTypeOverride,
  onViewInList,
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  pair: Transaction | null;
  onConfirm: () => void;
  onTypeOverride: (type: TransactionType) => void;
  onViewInList: () => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
}) {
  return (
    <div className="triage-card triage-card--cc-payment">
      <div className="triage-card-type">💳 CC Payment</div>
      <div className="triage-card-amount">{txAmountLabel(tx)}</div>
      <div className="triage-card-payee">{tx.payee || tx.description || '(unknown payee)'}</div>
      <div className="triage-card-meta">
        <span>{tx.account}</span>
        <span>{fmtDate(tx.date)}</span>
      </div>
      {pair && (
        <div className="triage-pair-match">Matched with {pair.account}</div>
      )}
      <button className="triage-view-in-list" onClick={onViewInList}>View in list →</button>
      <div className="triage-actions">
        <button className="btn btn-primary" onClick={onConfirm}>
          Confirm
        </button>
      </div>
      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not a CC payment {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('income')}>💰 Income</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('transfer')}>↔️ Transfer</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('regular')}>🛒 Purchase</button>
        </div>
      )}
    </div>
  );
}

function PurchaseCard({
  tx,
  categories,
  selectedCategory,
  suggestedCategory,
  onSelectCategory,
  onAssign,
  onTypeOverride,
  onViewInList,
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  categories: BudgetCategory[];
  selectedCategory: string;
  suggestedCategory: string;
  onSelectCategory: (cat: string) => void;
  onAssign: () => void;
  onTypeOverride: (type: TransactionType) => void;
  onViewInList: () => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
}) {
  const RTA_VALUE = '__rta__';

  const suggested = suggestedCategory;
  const others = categories.filter((c) => c.category !== suggested);

  return (
    <div className="triage-card triage-card--regular">
      <div className="triage-card-amount triage-card-amount--negative">{txAmountLabel(tx)}</div>
      <div className="triage-card-payee">{tx.payee || tx.description || '(unknown payee)'}</div>
      <div className="triage-card-meta">
        <span>{tx.account}</span>
        <span>{fmtDate(tx.date)}</span>
      </div>
      <button className="triage-view-in-list" onClick={onViewInList}>View in list →</button>

      <div className="triage-category-list">
        <button
          className={`triage-category-item triage-category-item--rta${selectedCategory === RTA_VALUE ? ' selected' : ''}`}
          onClick={() => onSelectCategory(RTA_VALUE)}
        >
          <em>Ready to Assign</em>
        </button>

        {suggested && (
          <button
            className={`triage-category-item triage-category-item--suggested${selectedCategory === suggested ? ' selected' : ''}`}
            onClick={() => onSelectCategory(suggested)}
          >
            ★ {suggested}
          </button>
        )}

        {others.map((c) => (
          <button
            key={c.category}
            className={`triage-category-item${selectedCategory === c.category ? ' selected' : ''}`}
            onClick={() => onSelectCategory(c.category)}
          >
            {c.category}
          </button>
        ))}
      </div>

      <div className="triage-actions">
        <button
          className="btn btn-primary"
          onClick={onAssign}
          disabled={!selectedCategory}
        >
          Assign
        </button>
      </div>

      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not a purchase {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('income')}>💰 Income</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('transfer')}>↔️ Transfer</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('credit_payment')}>💳 CC Payment</button>
        </div>
      )}
    </div>
  );
}

// ─── Stale manual transaction banner ─────────────────────────────────────────

const STALE_DAYS = 14;

function staleCutoff(): string {
  const d = new Date();
  d.setDate(d.getDate() - STALE_DAYS);
  return d.toISOString().slice(0, 10);
}

function StaleManualBanner({ txns, onDelete }: { txns: Transaction[]; onDelete: (tx: Transaction) => void }) {
  const [open, setOpen] = useState(false);
  if (txns.length === 0) return null;
  return (
    <div className="stale-manual-banner">
      <button className="stale-manual-banner__toggle" onClick={() => setOpen((o) => !o)}>
        <span>⚠️ {txns.length} manual {txns.length === 1 ? "transaction hasn't" : "transactions haven't"} cleared in {STALE_DAYS}+ days</span>
        <span className="stale-manual-banner__chevron">{open ? '▲' : '▾'}</span>
      </button>
      {open && (
        <ul className="stale-manual-list">
          {txns.map((tx) => (
            <li key={tx.transaction_id} className="stale-manual-item">
              <div className="stale-manual-item__info">
                <span className="stale-manual-item__payee">{tx.payee || '(no payee)'}</span>
                <span className="stale-manual-item__meta">{fmtDate(tx.date)} · {tx.account}</span>
              </div>
              <span className="stale-manual-item__amount">
                {tx.outflow > 0 ? `-${fmt(tx.outflow)}` : `+${fmt(tx.inflow)}`}
              </span>
              <button className="stale-manual-item__delete" onClick={() => onDelete(tx)} title="Cancel transaction">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Unknown account banner ───────────────────────────────────────────────────

function UnknownAccountBanner({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false);
  if (names.length === 0) return null;
  return (
    <div className="unknown-account-banner">
      <button className="unknown-account-banner__toggle" onClick={() => setOpen((o) => !o)}>
        <span>
          ⚠️ {names.length} unrecognized account {names.length === 1 ? 'name' : 'names'} in your transactions
        </span>
        <span className="stale-manual-banner__chevron">{open ? '▲' : '▾'}</span>
      </button>
      {open && (
        <div className="unknown-account-banner__body">
          {names.map((name) => (
            <div key={name} className="unknown-account-banner__name">{name}</div>
          ))}
          <p className="unknown-account-banner__hint">
            Add these to the <strong>Accounts</strong> tab in the spreadsheet to resolve this warning.
          </p>
        </div>
      )}
    </div>
  );
}

function TypeSelectCard({ onSelect }: { onSelect: (type: TransactionType) => void }) {
  return (
    <div className="triage-card triage-card--type-select">
      <div className="triage-card-type">What type of transaction is this?</div>
      <div className="triage-type-selector triage-type-selector--large">
        <button className="triage-type-pill" onClick={() => onSelect('income')}>💰 Income</button>
        <button className="triage-type-pill" onClick={() => onSelect('transfer')}>↔️ Transfer</button>
        <button className="triage-type-pill" onClick={() => onSelect('credit_payment')}>💳 CC Payment</button>
        <button className="triage-type-pill" onClick={() => onSelect('regular')}>🛒 Purchase</button>
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function Triage() {
  const { token, notifySessionExpired } = useAuth();
  const navigate = useNavigate();

  const rawAllTxns = useLiveQuery(() => db.transactions.toArray(), []);
  const rawCategories = useLiveQuery(() => getActiveBudgetCategories(), []);
  const unknownAccountNames = useLiveQuery(() => getUnknownAccountNames(), []) ?? [];

  const allTxns = rawAllTxns ?? [];
  const categories = rawCategories ?? [];

  // Unreviewed, non-split-child, non-manual transactions, oldest-first.
  // Manual transactions are pre-entered by the user and don't need triage unless stale.
  const triageQueue = useMemo(
    () =>
      allTxns
        .filter((t) => !t.parent_id && !t.reviewed && t.status !== 'manual')
        .sort((a, b) => a.date.localeCompare(b.date)),
    [allTxns]
  );

  // Manual transactions that haven't cleared in STALE_DAYS days
  const staleManual = useMemo(() => {
    const cutoff = staleCutoff();
    return allTxns.filter(
      (t) => t.status === 'manual' && !t.matched_id && t.date <= cutoff
    );
  }, [allTxns]);

  const [index, setIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [resolvedSuggestion, setResolvedSuggestion] = useState('');
  const [overrideType, setOverrideType] = useState<TransactionType | null>(null);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tx = triageQueue[index];

  // Reset card state when navigating to a different transaction
  useEffect(() => {
    if (!tx) return;
    setSelectedCategory(tx.category ?? '');
    setOverrideType(null);
    setEscapeOpen(false);
    setResolvedSuggestion('');

    // Resolve suggestion: payee history first, then Plaid hint as fallback
    getSuggestedCategory(tx.payee).then((payeeSuggestion) => {
      const suggestion = payeeSuggestion ?? tx.suggested_category ?? '';
      setResolvedSuggestion(suggestion);
      // Pre-select only if no category is already assigned
      if (!tx.category && suggestion) {
        setSelectedCategory(suggestion);
      }
    });
  }, [tx?.transaction_id, index]);

  const advance = () => setIndex((i) => i + 1);
  const goBack = () => setIndex((i) => Math.max(0, i - 1));

  // Must be declared before any early returns so hook call order is stable.
  const handleDeleteStaleManual = useCallback(async (tx: Transaction) => {
    if (!token) return;
    if (!confirm(`Delete "${tx.payee || 'this transaction'}" (${tx.outflow > 0 ? fmt(tx.outflow) : fmt(tx.inflow)})?`)) return;
    try {
      await db.transactions.delete(tx.transaction_id);
      const client = new SheetsClient(SHEET_ID, token);
      await client.updateValues(`Transactions!A${tx._rowIndex}`, [['']] );
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Failed to delete — please try again');
    }
  }, [token, notifySessionExpired]);

  if (rawAllTxns === undefined || rawCategories === undefined) {
    return <div className="screen triage-screen"><div className="state-msg">Loading…</div></div>;
  }

  if (error) {
    return (
      <div className="screen triage-screen">
        <div className="state-msg error">
          {error}
          <button className="btn btn-secondary" style={{ marginTop: '1rem' }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  const total = triageQueue.length;

  if (index >= total) {
    return (
      <div className="screen triage-screen">
        <StaleManualBanner txns={staleManual} onDelete={handleDeleteStaleManual} />
        <UnknownAccountBanner names={unknownAccountNames} />
        <div className="triage-all-caught-up">
          <div className="triage-caught-up-emoji">🎉</div>
          <div className="triage-caught-up-text">All caught up!</div>
          <button className="btn btn-secondary" onClick={() => navigate('/accounts')}>
            Back to Accounts
          </button>
        </div>
      </div>
    );
  }

  const effectiveType = overrideType ?? classifyTransactionType(tx);
  const pair: Transaction | null = (() => {
    if (tx.transfer_pair_id) return allTxns.find((t) => t.transaction_id === tx.transfer_pair_id) ?? null;
    if (effectiveType === 'transfer') return findTransferPair(tx, allTxns);
    if (effectiveType === 'credit_payment') return findCcPaymentPair(tx, allTxns);
    return null;
  })();

  const handleApproveIncome = async () => {
    if (!token) return;
    try {
      await optimisticApproveIncome(tx, new SheetsClient(SHEET_ID, token));
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Failed to save — change reverted');
    }
  };

  const handleConfirmTransfer = async () => {
    if (!token) return;
    try {
      await optimisticConfirmTransfer(tx, pair, new SheetsClient(SHEET_ID, token), 'transfer');
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Failed to save — change reverted');
    }
  };

  const handleConfirmCcPayment = async () => {
    if (!token) return;
    try {
      await optimisticConfirmTransfer(tx, pair, new SheetsClient(SHEET_ID, token), 'credit_payment');
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Failed to save — change reverted');
    }
  };

  const handleAssignPurchase = async () => {
    if (!token || !selectedCategory) return;
    const RTA_VALUE = '__rta__';
    const chosenCat = selectedCategory === RTA_VALUE ? '' : selectedCategory;
    const catRecord = categories.find((c) => c.category === chosenCat);
    try {
      await optimisticAssignPurchase(tx, chosenCat, catRecord, new SheetsClient(SHEET_ID, token));
    } catch (e) {
      if (e instanceof AuthError) { notifySessionExpired(); return; }
      setError('Failed to save — change reverted');
    }
  };

  const handleTypeOverride = (type: TransactionType) => {
    setOverrideType(type);
    setEscapeOpen(false);
    setSelectedCategory('');
  };

  return (
    <div className="screen triage-screen">
      <header className="screen-header">
        <button className="triage-nav-btn" onClick={() => navigate('/accounts')}>✕</button>
        <div className="triage-progress">{index + 1} of {total}</div>
        <div className="triage-nav-arrows">
          <button className="triage-nav-btn" onClick={goBack} disabled={index === 0}>‹</button>
          <button className="triage-nav-btn" onClick={advance} disabled={index >= total - 1}>›</button>
        </div>
      </header>

      <StaleManualBanner txns={staleManual} onDelete={handleDeleteStaleManual} />
      <UnknownAccountBanner names={unknownAccountNames} />

      <div className="triage-card-wrapper">
        {effectiveType === '' && (
          <TypeSelectCard onSelect={handleTypeOverride} />
        )}
        {effectiveType === 'income' && (
          <IncomeCard
            tx={tx}
            onApprove={handleApproveIncome}
            onTypeOverride={handleTypeOverride}
            onViewInList={() => navigate('/accounts', { state: { highlightId: tx.transaction_id } })}
            escapeOpen={escapeOpen}
            onToggleEscape={() => setEscapeOpen((o) => !o)}
          />
        )}
        {effectiveType === 'transfer' && (
          <TransferCard
            tx={tx}
            pair={pair}
            onConfirm={handleConfirmTransfer}
            onTypeOverride={handleTypeOverride}
            onViewInList={() => navigate('/accounts', { state: { highlightId: tx.transaction_id } })}
            escapeOpen={escapeOpen}
            onToggleEscape={() => setEscapeOpen((o) => !o)}
          />
        )}
        {effectiveType === 'credit_payment' && (
          <CcPaymentCard
            tx={tx}
            pair={pair}
            onConfirm={handleConfirmCcPayment}
            onTypeOverride={handleTypeOverride}
            onViewInList={() => navigate('/accounts', { state: { highlightId: tx.transaction_id } })}
            escapeOpen={escapeOpen}
            onToggleEscape={() => setEscapeOpen((o) => !o)}
          />
        )}
        {effectiveType === 'regular' && (
          <PurchaseCard
            tx={tx}
            categories={categories}
            selectedCategory={selectedCategory}
            suggestedCategory={resolvedSuggestion}
            onSelectCategory={setSelectedCategory}
            onAssign={handleAssignPurchase}
            onTypeOverride={handleTypeOverride}
            onViewInList={() => navigate('/accounts', { state: { highlightId: tx.transaction_id } })}
            escapeOpen={escapeOpen}
            onToggleEscape={() => setEscapeOpen((o) => !o)}
          />
        )}
      </div>

      <div className="triage-skip-row">
        <button className="btn btn-ghost" onClick={goBack} disabled={index === 0}>
          ‹ Back
        </button>
        <button className="btn btn-ghost" onClick={advance} disabled={index >= total - 1}>
          Skip ›
        </button>
      </div>
    </div>
  );
}
