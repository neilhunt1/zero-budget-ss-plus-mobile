import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '../hooks/useAuth';
import { SheetsClient } from '../api/client';
import {
  classifyTransactionType,
  findTransferPair,
  findCcPaymentPair,
} from '../api/transactions';
import { getActiveBudgetCategories, getSuggestedCategory } from '../db/queries';
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
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  onApprove: () => void;
  onTypeOverride: (type: TransactionType) => void;
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
        <span>{tx.date}</span>
      </div>
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
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  pair: Transaction | null;
  onConfirm: () => void;
  onTypeOverride: (type: TransactionType) => void;
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
        <span>{tx.date}</span>
      </div>
      {pair && (
        <div className="triage-pair-match">Matched with {pair.account}</div>
      )}
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
  escapeOpen,
  onToggleEscape,
}: {
  tx: Transaction;
  pair: Transaction | null;
  onConfirm: () => void;
  onTypeOverride: (type: TransactionType) => void;
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
        <span>{tx.date}</span>
      </div>
      {pair && (
        <div className="triage-pair-match">Matched with {pair.account}</div>
      )}
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
        <span>{tx.date}</span>
      </div>

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
  const { token } = useAuth();
  const navigate = useNavigate();

  const rawAllTxns = useLiveQuery(() => db.transactions.toArray(), []);
  const rawCategories = useLiveQuery(() => getActiveBudgetCategories(), []);

  const allTxns = rawAllTxns ?? [];
  const categories = rawCategories ?? [];

  // Unreviewed, non-split-child transactions, oldest-first
  const triageQueue = useMemo(
    () =>
      allTxns
        .filter((t) => !t.parent_id && !t.reviewed)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [allTxns]
  );

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
      setError('Failed to save — change reverted');
    }
  };

  const handleConfirmTransfer = async () => {
    if (!token) return;
    try {
      await optimisticConfirmTransfer(tx, pair, new SheetsClient(SHEET_ID, token), 'transfer');
    } catch (e) {
      setError('Failed to save — change reverted');
    }
  };

  const handleConfirmCcPayment = async () => {
    if (!token) return;
    try {
      await optimisticConfirmTransfer(tx, pair, new SheetsClient(SHEET_ID, token), 'credit_payment');
    } catch (e) {
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

      <div className="triage-card-wrapper">
        {effectiveType === '' && (
          <TypeSelectCard onSelect={handleTypeOverride} />
        )}
        {effectiveType === 'income' && (
          <IncomeCard
            tx={tx}
            onApprove={handleApproveIncome}
            onTypeOverride={handleTypeOverride}
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
