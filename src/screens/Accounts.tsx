import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { Transaction } from '../types';

interface AccountSummary {
  name: string;
  balance: number; // inflow − outflow (net change from all transactions)
  lastActivity: string; // date of most recent transaction
  txCount: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
}

function buildAccountSummaries(transactions: Transaction[]): AccountSummary[] {
  const map = new Map<string, AccountSummary>();

  for (const tx of transactions) {
    if (!tx.account || tx.transaction_type === 'transfer') continue;
    if (!map.has(tx.account)) {
      map.set(tx.account, {
        name: tx.account,
        balance: 0,
        lastActivity: tx.date,
        txCount: 0,
      });
    }
    const summary = map.get(tx.account)!;
    summary.balance += tx.inflow - tx.outflow;
    summary.txCount += 1;
    if (tx.date > summary.lastActivity) summary.lastActivity = tx.date;
  }

  return [...map.values()].sort((a, b) => b.balance - a.balance);
}

// blank category = red, pending = orange, otherwise = green
function txStatusClass(tx: Transaction): 'dot--red' | 'dot--orange' | 'dot--green' {
  if (!tx.category) return 'dot--red';
  if (tx.status === 'pending') return 'dot--orange';
  return 'dot--green';
}

const RECENT_DAYS = 90;

function getDateCutoff(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export { buildAccountSummaries, txStatusClass };

export default function Accounts({ unreviewedCount }: { unreviewedCount: number | null }) {
  const navigate = useNavigate();
  const [selectedFilter, setSelectedFilter] = useState('all');

  const allTransactions = useLiveQuery(() => db.transactions.toArray());
  const loading = allTransactions === undefined;

  const cutoff = useMemo(() => getDateCutoff(RECENT_DAYS), []);

  const accounts = useMemo(
    () => buildAccountSummaries(allTransactions ?? []),
    [allTransactions]
  );
  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  const recentTransactions = useMemo(
    () =>
      (allTransactions ?? [])
        .filter((t) => !t.parent_id && t.date >= cutoff)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [allTransactions, cutoff]
  );

  const filteredTransactions = useMemo(() => {
    if (selectedFilter === 'all') return recentTransactions;
    if (selectedFilter === 'uncategorized') return recentTransactions.filter((t) => !t.category);
    return recentTransactions.filter((t) => t.account === selectedFilter);
  }, [recentTransactions, selectedFilter]);

  const filterOptions = useMemo(
    () => ['all', 'uncategorized', ...accounts.map((a) => a.name)],
    [accounts]
  );

  return (
    <div className="screen accounts-screen">
      <header className="screen-header">
        <h2 className="screen-title">Accounts</h2>
      </header>

      {loading && <div className="state-msg">Loading…</div>}

      {!loading && (
        <>
          {unreviewedCount != null && unreviewedCount > 0 && (
            <button className="triage-banner" onClick={() => navigate('/triage')}>
              {unreviewedCount} transaction{unreviewedCount !== 1 ? 's' : ''} need categories → Triage
            </button>
          )}

          <div className="accounts-total">
            <span className="accounts-total-label">Net Worth (from transactions)</span>
            <span className={`accounts-total-value ${totalBalance < 0 ? 'negative' : ''}`}>
              {fmt(totalBalance)}
            </span>
          </div>

          <div className="accounts-list">
            {accounts.map((acct) => (
              <div key={acct.name} className="account-row">
                <div className="account-info">
                  <span className="account-name">{acct.name}</span>
                  <span className="account-meta">{acct.txCount} transactions · last {acct.lastActivity}</span>
                </div>
                <span className={`account-balance ${acct.balance < 0 ? 'negative' : ''}`}>
                  {fmt(acct.balance)}
                </span>
              </div>
            ))}
          </div>

          {accounts.length === 0 && (
            <div className="state-msg">No transactions found.</div>
          )}

          <p className="accounts-note">
            Balances are calculated from transaction history only. True account balances
            will come from the Balance History (BTS) tab in a future update.
          </p>

          {/* ── Recent transaction list ─────────────────────────────────── */}
          <div className="tx-list-section-header">
            <span className="tx-list-section-title">Recent Transactions</span>
            <span className="tx-list-section-sub">Last {RECENT_DAYS} days</span>
          </div>

          <div className="filter-chips" role="group" aria-label="Filter transactions">
            {filterOptions.map((chip) => (
              <button
                key={chip}
                className={`filter-chip${selectedFilter === chip ? ' filter-chip--active' : ''}`}
                onClick={() => setSelectedFilter(chip)}
              >
                {chip === 'all' ? 'All' : chip === 'uncategorized' ? 'Uncategorized' : chip}
              </button>
            ))}
          </div>

          <div className="tx-list">
            {filteredTransactions.length === 0 ? (
              <div className="state-msg">No transactions in this view.</div>
            ) : (
              filteredTransactions.map((tx) => (
                <button
                  key={tx.transaction_id}
                  className="tx-row"
                  onClick={() => navigate(`/transactions/${encodeURIComponent(tx.transaction_id)}`)}
                >
                  <span className={`dot ${txStatusClass(tx)}`} aria-hidden="true" />
                  <div className="tx-row-main">
                    <span className="tx-payee">{tx.payee || tx.description || '(unknown)'}</span>
                    <span className="tx-meta">{tx.account} · {tx.date}</span>
                    <span className={`tx-category${!tx.category ? ' tx-category--none' : ''}`}>
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
        </>
      )}
    </div>
  );
}
