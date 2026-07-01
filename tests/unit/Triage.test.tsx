// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Transaction } from '../../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'fake-token' }),
}));

vi.mock('../../src/api/client', () => ({
  SheetsClient: vi.fn(),
}));

vi.mock('../../src/db/optimisticWrites', () => ({
  optimisticApproveIncome: vi.fn().mockResolvedValue(undefined),
  optimisticConfirmTransfer: vi.fn().mockResolvedValue(undefined),
  optimisticAssignPurchase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/queries', () => ({
  getActiveBudgetCategories: vi.fn().mockResolvedValue([]),
  getSuggestedCategory: vi.fn().mockResolvedValue(null),
  getStaleManualCount: vi.fn().mockResolvedValue(0),
  getUnknownAccountNames: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/api/transactions', async () => {
  const actual = await import('../../src/api/transactions');
  return {
    ...actual,
    findTransferPair: vi.fn().mockReturnValue(null),
    findCcPaymentPair: vi.fn().mockReturnValue(null),
  };
});

let mockTransactions: Transaction[] = [];

vi.mock('dexie-react-hooks', async () => {
  const { useState, useEffect } = await import('react');
  return {
    useLiveQuery: (fn: () => Promise<unknown> | unknown, deps: unknown[] = []) => {
      const [val, setVal] = useState<unknown>(undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => { Promise.resolve(fn()).then(setVal); }, deps);
      return val;
    },
  };
});

vi.mock('../../src/db/schema', () => ({
  db: {
    transactions: {
      toArray: () => Promise.resolve(mockTransactions),
    },
    accounts: {
      count: () => Promise.resolve(0),
      toArray: () => Promise.resolve([]),
    },
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 'tx-1',
    parent_id: '',
    split_group_id: '',
    source: 'banksheets',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2026-05-01',
    payee: 'Test Payee',
    description: '',
    category: '',
    suggested_category: '',
    category_subgroup: '',
    category_group: '',
    category_type: '',
    outflow: 50,
    inflow: 0,
    account: 'Capital One 360 Checking (6650)',
    memo: '',
    transaction_type: 'regular',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    _rowIndex: 2,
    ...overrides,
  };
}

async function renderTriage() {
  const { default: Triage } = await import('../../src/screens/Triage');
  const result = render(<Triage />);
  await waitFor(() => {
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
  return result;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Triage screen — card routing by transaction type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransactions = [];
  });

  it('shows "All caught up" when triage queue is empty', async () => {
    mockTransactions = [];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('All caught up!')).toBeInTheDocument());
  });

  it('renders IncomeCard for transaction_type=income', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'income', inflow: 5000, outflow: 0, category: '' })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('💰 Income')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('renders TransferCard for transaction_type=transfer', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'transfer', outflow: 1000 })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('↔️ Transfer')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('renders CcPaymentCard for transaction_type=credit_payment', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'credit_payment', outflow: 500 })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('💳 CC Payment')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('renders PurchaseCard for transaction_type=regular', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'regular', outflow: 50 })];
    await renderTriage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument());
  });

  it('renders TypeSelectCard for blank transaction_type (unclassified inflow)', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: '', inflow: 200, outflow: 0, category: '' })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('What type of transaction is this?')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '💳 CC Payment' })).toBeInTheDocument();
  });

  it('escape hatch on IncomeCard reveals type selector with CC Payment option', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'income', inflow: 1000, outflow: 0, category: '' })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('💰 Income')).toBeInTheDocument());

    const escapeBtn = screen.getByRole('button', { name: /Not income/i });
    await userEvent.click(escapeBtn);

    expect(screen.getByRole('button', { name: '↔️ Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🛒 Purchase' })).toBeInTheDocument();
  });

  it('escape hatch on TransferCard reveals CC Payment option', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: 'transfer', outflow: 500 })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('↔️ Transfer')).toBeInTheDocument());

    const escapeBtn = screen.getByRole('button', { name: /Not a transfer/i });
    await userEvent.click(escapeBtn);

    expect(screen.getByRole('button', { name: '💳 CC Payment' })).toBeInTheDocument();
  });

  it('selecting CC Payment from TypeSelectCard shows CcPaymentCard', async () => {
    mockTransactions = [makeTx({ transaction_id: 'tx-1', transaction_type: '', inflow: 200, outflow: 0, category: '' })];
    await renderTriage();
    await waitFor(() => expect(screen.getByText('What type of transaction is this?')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: '💳 CC Payment' }));

    expect(screen.getByText('💳 CC Payment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });
});
