import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useSheetSync } from '../hooks/useSheetSync';
import { SheetsClient } from '../api/client';
import {
  fetchTransactions,
  updateTransactionFields,
  classifyTransactionType,
  findTransferPair,
} from '../api/transactions';
import { fetchBudgetCategories } from '../api/budget';
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
  saving,
}: {
  tx: Transaction;
  onApprove: () => void;
  onTypeOverride: (type: TransactionType) => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
  saving: boolean;
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
        <button className="btn btn-primary" onClick={onApprove} disabled={saving}>
          {saving ? 'Saving…' : 'Approve'}
        </button>
      </div>
      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not income {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('transfer')}>↔️ Transfer</button>
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
  saving,
}: {
  tx: Transaction;
  pair: Transaction | null;
  onConfirm: () => void;
  onTypeOverride: (type: TransactionType) => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
  saving: boolean;
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
        <button className="btn btn-primary" onClick={onConfirm} disabled={saving}>
          {saving ? 'Saving…' : 'Confirm'}
        </button>
      </div>
      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not a transfer {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('income')}>💰 Income</button>
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
  onSelectCategory,
  onAssign,
  onTypeOverride,
  escapeOpen,
  onToggleEscape,
  saving,
}: {
  tx: Transaction;
  categories: BudgetCategory[];
  selectedCategory: string;
  onSelectCategory: (cat: string) => void;
  onAssign: () => void;
  onTypeOverride: (type: TransactionType) => void;
  escapeOpen: boolean;
  onToggleEscape: () => void;
  saving: boolean;
}) {
  const RTA_VALUE = '__rta__';

  // Build picker: suggested first (if present), then all others
  const suggested = tx.suggested_category;
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
        {/* Ready to Assign option */}
        <button
          className={`triage-category-item triage-category-item--rta${selectedCategory === RTA_VALUE ? ' selected' : ''}`}
          onClick={() => onSelectCategory(RTA_VALUE)}
        >
          <em>Ready to Assign</em>
        </button>

        {/* Suggested category */}
        {suggested && (
          <button
            className={`triage-category-item triage-category-item--suggested${selectedCategory === suggested ? ' selected' : ''}`}
            onClick={() => onSelectCategory(suggested)}
          >
            ★ {suggested}
          </button>
        )}

        {/* All other active categories */}
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
          disabled={saving || !selectedCategory}
        >
          {saving ? 'Saving…' : 'Assign'}
        </button>
      </div>

      <button className="triage-escape-hatch" onClick={onToggleEscape}>
        Not a purchase {escapeOpen ? '▲' : '▾'}
      </button>
      {escapeOpen && (
        <div className="triage-type-selector">
          <button className="triage-type-pill" onClick={() => onTypeOverride('income')}>💰 Income</button>
          <button className="triage-type-pill" onClick={() => onTypeOverride('transfer')}>↔️ Transfer</button>
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
        <button className="triage-type-pill" onClick={() => onSelect('regular')}>🛒 Purchase</button>
      </div>
    </div>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function Triage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const revision = useSheetSync(token);

  const [triageQueue, setTriageQueue] = useState<Transaction[]>([]);
  const [allTxns, setAllTxns] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [overrideType, setOverrideType] = useState<TransactionType | null>(null);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    setLoading(true);
    setError(null);
    try {
      const [allFetched, cats] = await Promise.all([
        fetchTransactions(client, { includeSplitChildren: true }),
        fetchBudgetCategories(client),
      ]);
      setAllTxns(allFetched);
      setTriageQueue(allFetched.filter((t) => !t.reviewed));
      setCategories(cats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, revision]);

  useEffect(() => { load(); }, [load]);

  // Sync card state whenever we navigate to a different card.
  // Pre-selects an existing category so already-categorized transactions show it highlighted.
  useEffect(() => {
    const tx = triageQueue[index];
    if (!tx) return;
    setSelectedCategory(tx.category ?? '');
    setOverrideType(null);
    setEscapeOpen(false);
  }, [index, triageQueue]);

  const advance = () => setIndex((i) => i + 1);
  const goBack = () => setIndex((i) => Math.max(0, i - 1));

  if (loading) return <div className="screen triage-screen"><div className="state-msg">Loading…</div></div>;
  if (error) return <div className="screen triage-screen"><div className="state-msg error">{error}</div></div>;

  const total = triageQueue.length;
  const remaining = total - index;

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

  const tx = triageQueue[index];
  const effectiveType = overrideType ?? classifyTransactionType(tx);
  const pair = (effectiveType === 'transfer' && overrideType === 'transfer')
    ? findTransferPair(tx, allTxns)
    : tx.transfer_pair_id
      ? allTxns.find((t) => t.transaction_id === tx.transfer_pair_id) ?? null
      : null;

  const handleApproveIncome = async () => {
    if (!token) return;
    setSaving(true);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      await updateTransactionFields(client, tx._rowIndex, {
        reviewed: true,
        transaction_type: 'income',
        category: '',
        category_group: '',
        category_type: '',
      });
      advance();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmTransfer = async () => {
    if (!token) return;
    setSaving(true);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      await updateTransactionFields(client, tx._rowIndex, {
        reviewed: true,
        transaction_type: 'transfer',
        ...(pair ? { transfer_pair_id: pair.transaction_id } : {}),
      });
      if (pair && !pair.transfer_pair_id) {
        await updateTransactionFields(client, pair._rowIndex, {
          transfer_pair_id: tx.transaction_id,
        });
      }
      advance();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleAssignPurchase = async () => {
    if (!token || !selectedCategory) return;
    setSaving(true);
    const RTA_VALUE = '__rta__';
    const isRta = selectedCategory === RTA_VALUE;
    const chosenCat = isRta ? '' : selectedCategory;
    const catRecord = categories.find((c) => c.category === chosenCat);
    try {
      const client = new SheetsClient(SHEET_ID, token);
      await updateTransactionFields(client, tx._rowIndex, {
        reviewed: true,
        transaction_type: 'regular',
        category: chosenCat,
        category_group: catRecord?.category_group ?? '',
        category_type: catRecord?.category_type ?? '',
      });
      advance();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
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
            saving={saving}
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
            saving={saving}
          />
        )}
        {effectiveType === 'regular' && (
          <PurchaseCard
            tx={tx}
            categories={categories}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            onAssign={handleAssignPurchase}
            onTypeOverride={handleTypeOverride}
            escapeOpen={escapeOpen}
            onToggleEscape={() => setEscapeOpen((o) => !o)}
            saving={saving}
          />
        )}
      </div>

      <div className="triage-skip-row">
        <button className="btn btn-ghost" onClick={goBack} disabled={saving || index === 0}>
          ‹ Back
        </button>
        <button className="btn btn-ghost" onClick={advance} disabled={saving}>
          Skip ›
        </button>
      </div>
    </div>
  );
}
