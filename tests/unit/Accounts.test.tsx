// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Transaction } from '../../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

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

const mockToArray = vi.fn();
vi.mock('../../src/db/schema', () => ({
  db: {
    transactions: { toArray: () => mockToArray() },
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<Transaction> & { transaction_id: string }): Transaction {
  return {
    transaction_id: overrides.transaction_id,
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2026-04-01',
    payee: 'Test Payee',
    description: '',
    category: 'Groceries 🛒',
    suggested_category: '',
    category_subgroup: '',
    category_group: '',
    category_type: '',
    outflow: 50,
    inflow: 0,
    account: 'Checking',
    memo: '',
    transaction_type: 'regular',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: true,
    _rowIndex: 2,
    ...overrides,
  };
}

// ─── Unit tests for exported helpers ─────────────────────────────────────────

describe('buildAccountSummaries', () => {
  it('aggregates balance and txCount per account', async () => {
    const { buildAccountSummaries } = await import('../../src/screens/Accounts');
    const txns = [
      makeTx({ transaction_id: 'a1', account: 'Checking', outflow: 50, inflow: 0 }),
      makeTx({ transaction_id: 'a2', account: 'Checking', outflow: 0, inflow: 200 }),
      makeTx({ transaction_id: 'a3', account: 'Savings', outflow: 0, inflow: 1000 }),
    ];
    const summaries = buildAccountSummaries(txns);
    const checking = summaries.find((s) => s.name === 'Checking')!;
    const savings = summaries.find((s) => s.name === 'Savings')!;

    expect(checking.balance).toBe(150); // 200 - 50
    expect(checking.txCount).toBe(2);
    expect(savings.balance).toBe(1000);
    expect(savings.txCount).toBe(1);
  });

  it('excludes transfer transactions from summaries', async () => {
    const { buildAccountSummaries } = await import('../../src/screens/Accounts');
    const txns = [
      makeTx({ transaction_id: 't1', account: 'Checking', transaction_type: 'transfer', outflow: 500, inflow: 0 }),
      makeTx({ transaction_id: 't2', account: 'Checking', outflow: 50, inflow: 0 }),
    ];
    const summaries = buildAccountSummaries(txns);
    const checking = summaries.find((s) => s.name === 'Checking')!;

    expect(checking.balance).toBe(-50);
    expect(checking.txCount).toBe(1);
  });

  it('sorts accounts by balance descending', async () => {
    const { buildAccountSummaries } = await import('../../src/screens/Accounts');
    const txns = [
      makeTx({ transaction_id: 's1', account: 'Savings', inflow: 5000, outflow: 0 }),
      makeTx({ transaction_id: 'c1', account: 'Checking', inflow: 100, outflow: 0 }),
    ];
    const summaries = buildAccountSummaries(txns);
    expect(summaries[0].name).toBe('Savings');
    expect(summaries[1].name).toBe('Checking');
  });
});

describe('txStatusClass', () => {
  it('returns dot--red for uncategorized transaction', async () => {
    const { txStatusClass } = await import('../../src/screens/Accounts');
    const tx = makeTx({ transaction_id: 'x1', category: '' });
    expect(txStatusClass(tx)).toBe('dot--red');
  });

  it('returns dot--orange for pending transaction with category', async () => {
    const { txStatusClass } = await import('../../src/screens/Accounts');
    const tx = makeTx({ transaction_id: 'x2', category: 'Groceries', status: 'pending' });
    expect(txStatusClass(tx)).toBe('dot--orange');
  });

  it('returns dot--green for categorized cleared transaction', async () => {
    const { txStatusClass } = await import('../../src/screens/Accounts');
    const tx = makeTx({ transaction_id: 'x3', category: 'Groceries', status: 'cleared' });
    expect(txStatusClass(tx)).toBe('dot--green');
  });

  it('returns dot--red even if pending but no category', async () => {
    const { txStatusClass } = await import('../../src/screens/Accounts');
    const tx = makeTx({ transaction_id: 'x4', category: '', status: 'pending' });
    expect(txStatusClass(tx)).toBe('dot--red');
  });
});

// ─── Component tests ─────────────────────────────────────────────────────────

describe('Accounts screen — transaction list', () => {
  // Use a recent date so transactions pass the 90-day cutoff
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('shows loading state while data is undefined', async () => {
    mockToArray.mockReturnValue(new Promise(() => {})); // never resolves
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders transaction payees in the list', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'tx1', payee: 'Whole Foods', date: today }),
      makeTx({ transaction_id: 'tx2', payee: 'Netflix', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByText('Whole Foods')).toBeInTheDocument();
      expect(screen.getByText('Netflix')).toBeInTheDocument();
    });
  });

  it('shows triage banner when unreviewedCount > 0', async () => {
    mockToArray.mockResolvedValue([]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={3} />);

    await waitFor(() => {
      expect(screen.getByText(/3 transactions need categories/i)).toBeInTheDocument();
    });
  });

  it('hides triage banner when unreviewedCount is 0', async () => {
    mockToArray.mockResolvedValue([]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={0} />);

    await waitFor(() => {
      expect(screen.queryByText(/need categories/i)).not.toBeInTheDocument();
    });
  });

  it('filters to Uncategorized chip correctly', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'cat', payee: 'Categorized Co', category: 'Groceries', date: today }),
      makeTx({ transaction_id: 'uncat', payee: 'Uncategorized Co', category: '', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    const uncatChip = await screen.findByRole('button', { name: 'Uncategorized' });
    fireEvent.click(uncatChip);

    await waitFor(() => {
      expect(screen.getByText('Uncategorized Co')).toBeInTheDocument();
      expect(screen.queryByText('Categorized Co')).not.toBeInTheDocument();
    });
  });

  it('filters by account chip correctly', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'c1', payee: 'Checking Payee', account: 'Checking', date: today }),
      makeTx({ transaction_id: 's1', payee: 'Savings Payee', account: 'Savings', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    const checkingChip = await screen.findByRole('button', { name: 'Checking' });
    fireEvent.click(checkingChip);

    await waitFor(() => {
      expect(screen.getByText('Checking Payee')).toBeInTheDocument();
      expect(screen.queryByText('Savings Payee')).not.toBeInTheDocument();
    });
  });

  it('excludes transactions older than 90 days from the list', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 91);
    const oldDateStr = oldDate.toISOString().slice(0, 10);

    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'old', payee: 'Old Payee', date: oldDateStr }),
      makeTx({ transaction_id: 'new', payee: 'New Payee', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByText('New Payee')).toBeInTheDocument();
      expect(screen.queryByText('Old Payee')).not.toBeInTheDocument();
    });
  });

  it('excludes split children (parent_id set) from the list', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'parent', payee: 'Parent Tx', date: today }),
      makeTx({ transaction_id: 'child', payee: 'Split Child', parent_id: 'parent', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByText('Parent Tx')).toBeInTheDocument();
      expect(screen.queryByText('Split Child')).not.toBeInTheDocument();
    });
  });

  it('navigates to /transactions/:id when a row is tapped', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'tx-abc-123', payee: 'Amazon', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    const row = await screen.findByRole('button', { name: /Amazon/i });
    fireEvent.click(row);

    expect(mockNavigate).toHaveBeenCalledWith('/transactions/tx-abc-123');
  });

  it('shows outflow amounts in red class', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'out1', payee: 'Grocery Store', outflow: 42.5, inflow: 0, date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      // Use querySelector to target the tx-row amount specifically (not the account balance)
      const amountEl = document.querySelector('.tx-amount--outflow');
      expect(amountEl).toBeInTheDocument();
      expect(amountEl?.textContent).toBe('-$42.50');
    });
  });

  it('shows inflow amounts in green class', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'in1', payee: 'Paycheck', outflow: 0, inflow: 1500, date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      const amountEl = document.querySelector('.tx-amount--inflow');
      expect(amountEl).toBeInTheDocument();
      expect(amountEl?.textContent).toBe('+$1,500.00');
    });
  });

  it('renders All, Uncategorized, and per-account filter chips', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'c1', account: 'Checking', date: today }),
      makeTx({ transaction_id: 's1', account: 'Savings', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Uncategorized' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Checking' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Savings' })).toBeInTheDocument();
    });
  });

  it('shows dot--red class for uncategorized transaction', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'u1', payee: 'Unknown Shop', category: '', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      const dot = document.querySelector('.dot--red');
      expect(dot).toBeInTheDocument();
    });
  });

  it('shows "Uncategorized" label in red when no category', async () => {
    mockToArray.mockResolvedValue([
      makeTx({ transaction_id: 'u2', payee: 'Mystery Store', category: '', date: today }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      // Use querySelector to target the category span inside a tx-row (not the filter chip)
      const catLabel = document.querySelector('.tx-category--none');
      expect(catLabel).toBeInTheDocument();
      expect(catLabel?.textContent).toBe('Uncategorized');
    });
  });
});
