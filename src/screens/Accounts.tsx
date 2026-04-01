import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { SheetsClient } from '../api/client';
import { fetchTransactions } from '../api/transactions';
import { Transaction } from '../types';

const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID as string;

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

export default function Accounts() {
  const { token } = useAuth();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const client = new SheetsClient(SHEET_ID, token);
    setLoading(true);
    setError(null);

    try {
      const transactions = await fetchTransactions(client);
      setAccounts(buildAccountSummaries(transactions));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="screen accounts-screen">
      <header className="screen-header">
        <h2 className="screen-title">Accounts</h2>
      </header>

      {loading && <div className="state-msg">Loading…</div>}
      {error && <div className="state-msg error">{error}</div>}

      {!loading && !error && (
        <>
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
        </>
      )}
    </div>
  );
}
