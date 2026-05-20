// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Transaction } from '../../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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

const mockGetRecentTransactions = vi.fn();
const mockSearchTransactions = vi.fn();
vi.mock('../../src/db/queries', () => ({
  getRecentTransactions: (...args: unknown[]) => mockGetRecentTransactions(...args),
  searchTransactions: (...args: unknown[]) => mockSearchTransactions(...args),
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
    date: '2026-05-01',
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

// ─── Unit tests for txRowClass ────────────────────────────────────────────────

describe('txRowClass', () => {
  it('returns tx-row for reviewed cleared transaction', async () => {
    const { txRowClass } = await import('../../src/screens/Accounts');
    expect(txRowClass(makeTx({ transaction_id: 'a', reviewed: true, status: 'cleared' }))).toBe('tx-row');
  });

  it('returns tx-row--unreviewed for unreviewed cleared transaction', async () => {
    const { txRowClass } = await import('../../src/screens/Accounts');
    expect(txRowClass(makeTx({ transaction_id: 'b', reviewed: false, status: 'cleared' }))).toBe('tx-row tx-row--unreviewed');
  });

  it('returns tx-row--pending for pending transaction (reviewed or not)', async () => {
    const { txRowClass } = await import('../../src/screens/Accounts');
    expect(txRowClass(makeTx({ transaction_id: 'c', reviewed: false, status: 'pending' }))).toBe('tx-row tx-row--pending');
    expect(txRowClass(makeTx({ transaction_id: 'd', reviewed: true, status: 'pending' }))).toBe('tx-row tx-row--pending');
  });

  it('pending takes priority over unreviewed', async () => {
    const { txRowClass } = await import('../../src/screens/Accounts');
    const tx = makeTx({ transaction_id: 'e', reviewed: false, status: 'pending' });
    expect(txRowClass(tx)).toBe('tx-row tx-row--pending');
    expect(txRowClass(tx)).not.toContain('unreviewed');
  });
});

// ─── Component tests ─────────────────────────────────────────────────────────

describe('Transactions screen — rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetRecentTransactions.mockResolvedValue([]);
    mockSearchTransactions.mockResolvedValue([]);
  });

  it('shows loading state while data is undefined', async () => {
    mockGetRecentTransactions.mockReturnValue(new Promise(() => {})); // never resolves — stays undefined
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders transaction payees after load', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'tx1', payee: 'Whole Foods' }),
      makeTx({ transaction_id: 'tx2', payee: 'Netflix' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByText('Whole Foods')).toBeInTheDocument();
      expect(screen.getByText('Netflix')).toBeInTheDocument();
    });
  });

  it('shows triage banner when unreviewedCount > 0', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={3} />);
    expect(screen.getByText(/3 transactions need categories/i)).toBeInTheDocument();
  });

  it('hides triage banner when unreviewedCount is 0', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={0} />);
    expect(screen.queryByText(/need categories/i)).not.toBeInTheDocument();
  });

  it('shows All, Unreviewed, and Pending filter chips', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unreviewed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
  });

  it('shows a search input', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByPlaceholderText(/search payee/i)).toBeInTheDocument();
  });

  it('shows scope hint with default range when no search', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByText(/last 90 days/i)).toBeInTheDocument();
  });
});

describe('Transactions screen — filter chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('Unreviewed chip shows only unreviewed transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'rev', payee: 'Reviewed Co', reviewed: true }),
      makeTx({ transaction_id: 'unrev', payee: 'Unreviewed Co', reviewed: false }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unreviewed' }));

    await waitFor(() => {
      expect(screen.getByText('Unreviewed Co')).toBeInTheDocument();
      expect(screen.queryByText('Reviewed Co')).not.toBeInTheDocument();
    });
  });

  it('Pending chip shows only pending transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'clr', payee: 'Cleared Co', status: 'cleared' }),
      makeTx({ transaction_id: 'pnd', payee: 'Pending Co', status: 'pending' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pending' }));

    await waitFor(() => {
      expect(screen.getByText('Pending Co')).toBeInTheDocument();
      expect(screen.queryByText('Cleared Co')).not.toBeInTheDocument();
    });
  });

  it('All chip restores full list after filtering', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'r', payee: 'Amazon', reviewed: true }),
      makeTx({ transaction_id: 'u', payee: 'Netflix', reviewed: false }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unreviewed' }));
    await waitFor(() => expect(screen.queryByText('Amazon')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(screen.getByText('Amazon')).toBeInTheDocument();
      expect(screen.getByText('Netflix')).toBeInTheDocument();
    });
  });
});

describe('Transactions screen — search', () => {
  // When search is active, the component calls searchTransactions (all-history).
  // When empty, it calls getRecentTransactions (90-day default).
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetRecentTransactions.mockResolvedValue([]);
    mockSearchTransactions.mockResolvedValue([]);
  });

  it('calls searchTransactions when user types a query', async () => {
    mockSearchTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'a', payee: 'Amazon Prime' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.change(screen.getByPlaceholderText(/search payee/i), { target: { value: 'amazon' } });

    await waitFor(() => expect(screen.getByText('Amazon Prime')).toBeInTheDocument());
    expect(mockSearchTransactions).toHaveBeenCalledWith('amazon');
  });

  it('shows searchTransactions results (not getRecentTransactions) when searching', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'recent', payee: 'Recent Payee' }),
    ]);
    mockSearchTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'found', payee: 'BGE Electric' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => expect(screen.getByText('Recent Payee')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/search payee/i), { target: { value: 'BGE' } });

    await waitFor(() => {
      expect(screen.getByText('BGE Electric')).toBeInTheDocument();
      expect(screen.queryByText('Recent Payee')).not.toBeInTheDocument();
    });
  });

  it('reverts to getRecentTransactions when search is cleared', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'r', payee: 'Whole Foods' }),
    ]);
    mockSearchTransactions.mockResolvedValue([
      makeTx({ transaction_id: 's', payee: 'BGE Electric' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.change(screen.getByPlaceholderText(/search payee/i), { target: { value: 'BGE' } });
    await waitFor(() => expect(screen.getByText('BGE Electric')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/search payee/i), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeInTheDocument());
    expect(screen.queryByText('BGE Electric')).not.toBeInTheDocument();
  });

  it('shows "X results across all history" hint when searching', async () => {
    mockSearchTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'h1', payee: 'BGE Electric' }),
      makeTx({ transaction_id: 'h2', payee: 'BGE Gas' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.change(screen.getByPlaceholderText(/search payee/i), { target: { value: 'BGE' } });

    await waitFor(() => expect(screen.getByText(/2 results across all history/i)).toBeInTheDocument());
  });

  it('shows "Last 90 days" hint when not searching', async () => {
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);
    expect(screen.getByText(/last 90 days/i)).toBeInTheDocument();
  });
});

describe('Transactions screen — visual treatment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('applies tx-row--unreviewed class to unreviewed transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'u', payee: 'Unknown Shop', reviewed: false, status: 'cleared' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-row--unreviewed')).toBeInTheDocument();
    });
  });

  it('applies tx-row--pending class to pending transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'p', payee: 'Pending Store', status: 'pending' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-row--pending')).toBeInTheDocument();
    });
  });

  it('shows green ✓ before category for reviewed transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'rv', reviewed: true, category: 'Groceries', status: 'cleared' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-reviewed-mark')).toBeInTheDocument();
    });
  });

  it('does not show ✓ for unreviewed transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'unrv', reviewed: false, category: 'Groceries' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
      expect(document.querySelector('.tx-reviewed-mark')).not.toBeInTheDocument();
    });
  });

  it('shows ⏳ in meta for pending transactions', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'pd', payee: 'Bank Pending', status: 'pending', date: '2026-05-10' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      const meta = document.querySelector('.tx-meta');
      expect(meta?.textContent).toContain('⏳');
    });
  });

  it('shows Uncategorized label in red class when no category', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'nc', payee: 'Mystery Store', category: '' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-category--none')).toBeInTheDocument();
      expect(document.querySelector('.tx-category--none')?.textContent).toContain('Uncategorized');
    });
  });

  it('outflow amount has tx-amount--outflow class', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'out', outflow: 42.5, inflow: 0 }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-amount--outflow')?.textContent).toBe('-$42.50');
    });
  });

  it('inflow amount has tx-amount--inflow class', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'in', outflow: 0, inflow: 1500 }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    await waitFor(() => {
      expect(document.querySelector('.tx-amount--inflow')?.textContent).toBe('+$1,500.00');
    });
  });
});

describe('Transactions screen — detail bottom sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('opens bottom sheet when a transaction row is tapped', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'tx1', payee: 'Coffee Shop', category: 'Dining Out' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    const row = await screen.findByRole('button', { name: /Coffee Shop/i });
    fireEvent.click(row);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('bottom sheet shows transaction details', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'tx2', payee: 'Trader Joes', category: 'Groceries', outflow: 85, inflow: 0 }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    const row = await screen.findByRole('button', { name: /Trader Joes/i });
    fireEvent.click(row);

    expect(screen.getAllByText('Trader Joes').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.tx-detail-hero')).toBeInTheDocument();
    expect(document.querySelector('.tx-detail-amount')?.textContent).toBe('-$85.00');
  });

  it('closes bottom sheet when Close is clicked', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'tx3', payee: 'Gym' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Gym/i }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('closes bottom sheet when backdrop overlay is clicked', async () => {
    mockGetRecentTransactions.mockResolvedValue([
      makeTx({ transaction_id: 'tx4', payee: 'Target' }),
    ]);
    const { default: Accounts } = await import('../../src/screens/Accounts');
    render(<Accounts unreviewedCount={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Target/i }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    fireEvent.click(document.querySelector('.assign-overlay')!);
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });
});
