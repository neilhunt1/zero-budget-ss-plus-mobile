import { useParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { Transaction } from '../types';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function DetailRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

function formatTx(tx: Transaction) {
  const isInflow = tx.inflow > 0;
  const amount = isInflow ? fmt(tx.inflow) : fmt(tx.outflow);
  const amountDisplay = `${isInflow ? '+' : '-'}${amount}`;
  return { isInflow, amountDisplay };
}

export default function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // null = not found after load, undefined = still loading
  const tx = useLiveQuery(async () => {
    if (!id) return null;
    const found = await db.transactions.get(decodeURIComponent(id));
    return found ?? null;
  }, [id]);

  if (tx === undefined) {
    return <div className="screen"><div className="state-msg">Loading…</div></div>;
  }

  if (tx === null) {
    return (
      <div className="screen tx-detail-screen">
        <header className="screen-header">
          <button className="triage-nav-btn" onClick={() => navigate(-1)}>←</button>
          <h2 className="screen-title">Transaction</h2>
        </header>
        <div className="state-msg">Transaction not found.</div>
      </div>
    );
  }

  const { isInflow, amountDisplay } = formatTx(tx);

  return (
    <div className="screen tx-detail-screen">
      <header className="screen-header">
        <button className="triage-nav-btn" onClick={() => navigate(-1)}>←</button>
        <h2 className="screen-title">Transaction</h2>
      </header>

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
        <DetailRow label="Category Subgroup" value={tx.category_subgroup} />
        <DetailRow label="Status" value={tx.status} />
        <DetailRow label="Reviewed" value={tx.reviewed ? 'Yes' : 'No'} />
        <DetailRow label="Type" value={tx.transaction_type} />
        <DetailRow label="Source" value={tx.source} />
        <DetailRow label="Memo" value={tx.memo} />
        {tx.inflow > 0 && <DetailRow label="Inflow" value={fmt(tx.inflow)} />}
        {tx.outflow > 0 && <DetailRow label="Outflow" value={fmt(tx.outflow)} />}
        <DetailRow label="Flag" value={tx.flag} />
        {tx.needs_reimbursement && (
          <DetailRow label="Needs Reimbursement" value="Yes" />
        )}
        <DetailRow label="Transaction ID" value={tx.transaction_id} />
      </div>
    </div>
  );
}
