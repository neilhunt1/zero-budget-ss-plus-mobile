// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Transaction, BudgetAssignment } from '../../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'fake-token' }),
}));

vi.mock('../../src/hooks/useSheetSync', () => ({
  useSheetSync: () => 0,
}));

vi.mock('../../src/api/client', () => ({
  SheetsClient: vi.fn(),
}));

const mockFetchBudgetCategories = vi.fn().mockResolvedValue([]);
const mockFetchMonthAssignments = vi.fn();
const mockBuildGroupedBudget = vi.fn().mockReturnValue([]);

vi.mock('../../src/api/budget', () => ({
  fetchBudgetCategories: (...args: unknown[]) => mockFetchBudgetCategories(...args),
  fetchMonthAssignments: (...args: unknown[]) => mockFetchMonthAssignments(...args),
  buildGroupedBudget: (...args: unknown[]) => mockBuildGroupedBudget(...args),
}));

const mockFetchTransactions = vi.fn();
const mockComputeCategoryActivity = vi.fn().mockReturnValue({});

vi.mock('../../src/api/transactions', () => ({
  fetchTransactions: (...args: unknown[]) => mockFetchTransactions(...args),
  computeCategoryActivity: (...args: unknown[]) => mockComputeCategoryActivity(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    transaction_id: 't1',
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2026-04-15',
    payee: 'Test',
    description: '',
    category: '',
    suggested_category: '',
    category_subgroup: '',
    category_group: '',
    category_type: '',
    outflow: 0,
    inflow: 0,
    account: '',
    memo: '',
    transaction_type: 'credit',
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

function makeAssignment(assigned: number): BudgetAssignment {
  return { month: '2026-04', category: 'Groceries', assigned, source: 'manual', _rowIndex: 509 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Plan screen — Ready to Assign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBudgetCategories.mockResolvedValue([]);
    mockBuildGroupedBudget.mockReturnValue([]);
    mockComputeCategoryActivity.mockReturnValue({});
  });

  it('shows positive Ready to Assign in green', async () => {
    mockFetchTransactions.mockResolvedValue([
      makeTransaction({ inflow: 500, transaction_type: 'credit' }),
    ]);
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(200)]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    await waitFor(() => {
      expect(screen.getByText('$300')).toBeInTheDocument();
    });

    const valueEl = screen.getByText('$300');
    expect(valueEl).toHaveClass('positive');
    expect(valueEl).not.toHaveClass('negative');
  });

  it('shows negative Ready to Assign in red', async () => {
    mockFetchTransactions.mockResolvedValue([
      makeTransaction({ inflow: 100, transaction_type: 'credit' }),
    ]);
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(400)]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    await waitFor(() => {
      expect(screen.getByText('-$300')).toBeInTheDocument();
    });

    const valueEl = screen.getByText('-$300');
    expect(valueEl).toHaveClass('negative');
    expect(valueEl).not.toHaveClass('positive');
  });

  it('excludes transfer transactions from inflow sum', async () => {
    mockFetchTransactions.mockResolvedValue([
      makeTransaction({ transaction_id: 't1', inflow: 500, transaction_type: 'transfer' }),
      makeTransaction({ transaction_id: 't2', inflow: 100, transaction_type: 'credit' }),
    ]);
    mockFetchMonthAssignments.mockResolvedValue([]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    await waitFor(() => {
      expect(screen.getByText('$100')).toBeInTheDocument();
    });

    expect(screen.queryByText('$600')).not.toBeInTheDocument();
  });
});
