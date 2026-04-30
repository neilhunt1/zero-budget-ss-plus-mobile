// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BudgetAssignment, CategoryWithActivity, GroupedBudget } from '../../src/types';

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
const mockFetchMonthAssignments = vi.fn().mockResolvedValue([]);
const mockFetchCategoryCalcs = vi.fn().mockResolvedValue(new Map());
const mockFetchReadyToAssign = vi.fn().mockResolvedValue(0);
const mockBuildGroupedBudget = vi.fn().mockReturnValue([]);
const mockUpsertAssignment = vi.fn().mockResolvedValue(undefined);
const mockAppendLogEntry = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/api/budget', () => ({
  fetchBudgetCategories: (...args: unknown[]) => mockFetchBudgetCategories(...args),
  fetchMonthAssignments: (...args: unknown[]) => mockFetchMonthAssignments(...args),
  fetchCategoryCalcs: (...args: unknown[]) => mockFetchCategoryCalcs(...args),
  fetchReadyToAssign: (...args: unknown[]) => mockFetchReadyToAssign(...args),
  buildGroupedBudget: (...args: unknown[]) => mockBuildGroupedBudget(...args),
  upsertAssignment: (...args: unknown[]) => mockUpsertAssignment(...args),
  appendLogEntry: (...args: unknown[]) => mockAppendLogEntry(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAssignment(assigned: number): BudgetAssignment {
  return { month: '2026-04', category: 'Groceries', assigned, source: 'manual', _rowIndex: 509 };
}

function makeCat(overrides: Partial<CategoryWithActivity> = {}): CategoryWithActivity {
  return {
    category_group: 'Food',
    category_subgroup: '',
    category: 'Groceries',
    category_type: 'fluid',
    monthly_template_amount: 0,
    sort_order: 1,
    active: true,
    _rowIndex: 7,
    assigned: 400,
    activity: 100,
    available: 300,
    ...overrides,
  };
}

function makeGroupedBudget(cats: CategoryWithActivity[] = [makeCat()]): GroupedBudget[] {
  return [{
    groupName: 'Food',
    subgroups: [{ subgroupName: '', categories: cats }],
    totalAssigned: cats.reduce((s, c) => s + c.assigned, 0),
    totalActivity: cats.reduce((s, c) => s + c.activity, 0),
    totalAvailable: cats.reduce((s, c) => s + c.available, 0),
  }];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Plan screen — Ready to Assign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBudgetCategories.mockResolvedValue([]);
    mockFetchMonthAssignments.mockResolvedValue([]);
    mockFetchCategoryCalcs.mockResolvedValue(new Map());
    mockBuildGroupedBudget.mockReturnValue([]);
    mockUpsertAssignment.mockResolvedValue(undefined);
    mockAppendLogEntry.mockResolvedValue(undefined);
  });

  it('shows positive Ready to Assign from the sheet formula in green', async () => {
    mockFetchReadyToAssign.mockResolvedValue(300);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    await waitFor(() => {
      expect(screen.getByText('$300')).toBeInTheDocument();
    });

    const valueEl = screen.getByText('$300');
    expect(valueEl).toHaveClass('positive');
    expect(valueEl).not.toHaveClass('negative');
  });

  it('shows negative Ready to Assign from the sheet formula in red', async () => {
    mockFetchReadyToAssign.mockResolvedValue(-300);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    await waitFor(() => {
      expect(screen.getByText('-$300')).toBeInTheDocument();
    });

    const valueEl = screen.getByText('-$300');
    expect(valueEl).toHaveClass('negative');
    expect(valueEl).not.toHaveClass('positive');
  });
});

describe('Plan screen — assign money', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBudgetCategories.mockResolvedValue([]);
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(400)]);
    mockFetchCategoryCalcs.mockResolvedValue(new Map());
    mockFetchReadyToAssign.mockResolvedValue(500);
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudget());
    mockUpsertAssignment.mockResolvedValue(undefined);
    mockAppendLogEntry.mockResolvedValue(undefined);
  });

  it('opens the assignment sheet when a category row is clicked', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('prefills the input with the current assigned amount', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    expect(screen.getByRole('spinbutton')).toHaveValue(400);
  });

  it('shows empty input when assigned is zero', async () => {
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudget([makeCat({ assigned: 0, available: 0 })]));

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    expect(screen.getByRole('spinbutton')).toHaveValue(null);
  });

  it('cancel closes the assignment sheet without saving', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(mockUpsertAssignment).not.toHaveBeenCalled();
  });

  it('clicking the overlay backdrop closes the sheet', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();

    fireEvent.click(document.querySelector('.assign-overlay')!);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('save calls upsertAssignment with new amount and existing row', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpsertAssignment).toHaveBeenCalled());
    expect(mockUpsertAssignment).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'Groceries',
      500,
      makeAssignment(400)
    );
  });

  it('save calls appendLogEntry with the delta', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockAppendLogEntry).toHaveBeenCalled());
    expect(mockAppendLogEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'Groceries',
      200, // delta: 600 - 400
      'manual'
    );
  });

  it('empty input saves 0, not NaN', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpsertAssignment).toHaveBeenCalled());
    const [, , , amount] = mockUpsertAssignment.mock.calls[0];
    expect(amount).toBe(0);
    expect(Number.isNaN(amount)).toBe(false);
  });

  it('closes the sheet after a successful save', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    });
  });
});
