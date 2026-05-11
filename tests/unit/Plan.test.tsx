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
const mockApplyTemplate = vi.fn().mockResolvedValue(undefined);
const mockBatchUpsertAssignments = vi.fn().mockResolvedValue(undefined);
const mockBatchAppendLogEntries = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/api/budget', () => ({
  fetchBudgetCategories: (...args: unknown[]) => mockFetchBudgetCategories(...args),
  fetchMonthAssignments: (...args: unknown[]) => mockFetchMonthAssignments(...args),
  fetchCategoryCalcs: (...args: unknown[]) => mockFetchCategoryCalcs(...args),
  fetchReadyToAssign: (...args: unknown[]) => mockFetchReadyToAssign(...args),
  buildGroupedBudget: (...args: unknown[]) => mockBuildGroupedBudget(...args),
  upsertAssignment: (...args: unknown[]) => mockUpsertAssignment(...args),
  appendLogEntry: (...args: unknown[]) => mockAppendLogEntry(...args),
  applyTemplate: (...args: unknown[]) => mockApplyTemplate(...args),
  batchUpsertAssignments: (...args: unknown[]) => mockBatchUpsertAssignments(...args),
  batchAppendLogEntries: (...args: unknown[]) => mockBatchAppendLogEntries(...args),
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

describe('Plan screen — apply template', () => {
  function makeCatWithTemplate(overrides: Partial<CategoryWithActivity> = {}): CategoryWithActivity {
    return {
      category_group: 'Food',
      category_subgroup: '',
      category: 'Groceries',
      category_type: 'fluid',
      monthly_template_amount: 500,
      sort_order: 1,
      active: true,
      _rowIndex: 7,
      assigned: 0,
      activity: 0,
      available: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBudgetCategories.mockResolvedValue([]);
    mockFetchMonthAssignments.mockResolvedValue([]);
    mockFetchCategoryCalcs.mockResolvedValue(new Map());
    mockFetchReadyToAssign.mockResolvedValue(0);
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudget([makeCatWithTemplate()]));
    mockApplyTemplate.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the Apply Template button', async () => {
    mockFetchBudgetCategories.mockResolvedValue([makeCatWithTemplate()]);
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);
    expect(await screen.findByRole('button', { name: /Apply Template/i })).toBeInTheDocument();
  });

  it('button is disabled when no categories have a template amount', async () => {
    mockFetchBudgetCategories.mockResolvedValue([makeCatWithTemplate({ monthly_template_amount: 0 })]);
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);
    const btn = await screen.findByRole('button', { name: /Apply Template/i });
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it('calls applyTemplate with client, month, categories, and assignments', async () => {
    const cats = [makeCatWithTemplate({ monthly_template_amount: 500 })];
    const existing = [makeAssignment(200)];
    mockFetchBudgetCategories.mockResolvedValue(cats);
    mockFetchMonthAssignments.mockResolvedValue(existing);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const btn = await screen.findByRole('button', { name: /Apply Template/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() => expect(mockApplyTemplate).toHaveBeenCalled());
    expect(mockApplyTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      cats,
      existing
    );
  });

  it('shows confirm dialog when assignments already exist, and cancels if rejected', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockFetchBudgetCategories.mockResolvedValue([makeCatWithTemplate({ monthly_template_amount: 500 })]);
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(200)]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const btn = await screen.findByRole('button', { name: /Apply Template/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    expect(window.confirm).toHaveBeenCalled();
    expect(mockApplyTemplate).not.toHaveBeenCalled();
  });

  it('reloads data after applying', async () => {
    mockFetchBudgetCategories.mockResolvedValue([makeCatWithTemplate({ monthly_template_amount: 500 })]);
    mockFetchMonthAssignments.mockResolvedValue([]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const btn = await screen.findByRole('button', { name: /Apply Template/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    const callsBefore = mockFetchBudgetCategories.mock.calls.length;
    fireEvent.click(btn);

    await waitFor(() =>
      expect(mockFetchBudgetCategories.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });
});

describe('Plan screen — move money', () => {
  function makeSourceCat(overrides: Partial<CategoryWithActivity> = {}): CategoryWithActivity {
    return {
      category_group: 'Food',
      category_subgroup: '',
      category: 'Dining Out',
      category_type: 'fluid',
      monthly_template_amount: 0,
      sort_order: 2,
      active: true,
      _rowIndex: 8,
      assigned: 200,
      activity: 50,
      available: 150,
      ...overrides,
    };
  }

  function makeGroupedBudgetTwo(dest: CategoryWithActivity, source: CategoryWithActivity): GroupedBudget[] {
    return [{
      groupName: 'Food',
      subgroups: [{ subgroupName: '', categories: [dest, source] }],
      totalAssigned: dest.assigned + source.assigned,
      totalActivity: dest.activity + source.activity,
      totalAvailable: dest.available + source.available,
    }];
  }

  const destCat = makeCat({ category: 'Groceries', assigned: 400, available: 300 });
  const sourceCat = makeSourceCat({ category: 'Dining Out', assigned: 200, available: 150 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchBudgetCategories.mockResolvedValue([]);
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(400)]);
    mockFetchCategoryCalcs.mockResolvedValue(new Map());
    mockFetchReadyToAssign.mockResolvedValue(500);
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudgetTwo(destCat, sourceCat));
    mockUpsertAssignment.mockResolvedValue(undefined);
    mockAppendLogEntry.mockResolvedValue(undefined);
    mockBatchUpsertAssignments.mockResolvedValue(undefined);
    mockBatchAppendLogEntries.mockResolvedValue(undefined);
  });

  it('shows Move Money button in assignment sheet', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);

    expect(screen.getByRole('button', { name: /Move Money/i })).toBeInTheDocument();
  });

  it('clicking Move Money opens the category picker', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    expect(screen.getByText(/Pick a source category/i)).toBeInTheDocument();
  });

  it('picker excludes the destination category', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    const pickerItems = document.querySelectorAll('.picker-item');
    const pickerNames = [...pickerItems].map((el) => el.textContent);
    expect(pickerNames.some((t) => t?.includes('Dining Out'))).toBe(true);
    expect(pickerNames.some((t) => t?.includes('Groceries'))).toBe(false);
  });

  it('fluid categories appear first in the picker', async () => {
    const fixedCat = makeSourceCat({ category: 'Rent', category_type: 'fixed_bill', available: 9999 });
    const fluidCat = makeSourceCat({ category: 'Dining Out', category_type: 'fluid', available: 10 });
    mockBuildGroupedBudget.mockReturnValue([{
      groupName: 'Mixed',
      subgroups: [{ subgroupName: '', categories: [destCat, fixedCat, fluidCat] }],
      totalAssigned: 0, totalActivity: 0, totalAvailable: 0,
    }]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    const pickerItems = document.querySelectorAll('.picker-item');
    const names = [...pickerItems].map((el) => el.querySelector('.picker-item-name')?.textContent);
    expect(names[0]).toBe('Dining Out'); // fluid first even though lower available
  });

  it('selecting a source moves to confirm step', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    const pickerItem = document.querySelector('.picker-item') as HTMLElement;
    fireEvent.click(pickerItem);

    expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument();
    expect(screen.getByText(/Amount to move/i)).toBeInTheDocument();
  });

  it('Cover shortage button appears when destination is overspent', async () => {
    const overspentDest = makeCat({ category: 'Groceries', assigned: 100, available: -50 });
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudgetTwo(overspentDest, sourceCat));

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    const pickerItem = document.querySelector('.picker-item') as HTMLElement;
    fireEvent.click(pickerItem);

    expect(screen.getByRole('button', { name: /Cover shortage/i })).toBeInTheDocument();
  });

  it('Cover shortage button not shown when destination is not overspent', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    const pickerItem = document.querySelector('.picker-item') as HTMLElement;
    fireEvent.click(pickerItem);

    expect(screen.queryByRole('button', { name: /Cover shortage/i })).not.toBeInTheDocument();
  });

  it('Cover shortage pre-fills the exact deficit', async () => {
    const overspentDest = makeCat({ category: 'Groceries', assigned: 100, available: -75 });
    mockBuildGroupedBudget.mockReturnValue(makeGroupedBudgetTwo(overspentDest, sourceCat));

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    fireEvent.click(document.querySelector('.picker-item') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /Cover shortage/i }));

    expect(screen.getByRole('spinbutton')).toHaveValue(75);
  });

  it('confirm calls batchUpsertAssignments with source decrease and dest increase', async () => {
    const sourceAssignment: BudgetAssignment = {
      month: '2026-04', category: 'Dining Out', assigned: 200, source: 'manual', _rowIndex: 510,
    };
    mockFetchMonthAssignments.mockResolvedValue([makeAssignment(400), sourceAssignment]);

    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));
    fireEvent.click(document.querySelector('.picker-item') as HTMLElement);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => expect(mockBatchUpsertAssignments).toHaveBeenCalledTimes(1));
    const [, , entries] = mockBatchUpsertAssignments.mock.calls[0];
    // Source: Dining Out assigned 200 - 50 = 150
    expect(entries.some((e: { category: string; assigned: number }) => e.category === 'Dining Out' && e.assigned === 150)).toBe(true);
    // Dest: Groceries assigned 400 + 50 = 450
    expect(entries.some((e: { category: string; assigned: number }) => e.category === 'Groceries' && e.assigned === 450)).toBe(true);
  });

  it('confirm calls batchAppendLogEntries once with move_from and move_to entries', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));
    fireEvent.click(document.querySelector('.picker-item') as HTMLElement);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => expect(mockBatchAppendLogEntries).toHaveBeenCalledTimes(1));
    const [, entries] = mockBatchAppendLogEntries.mock.calls[0];
    expect(entries.some((e: { change_type: string }) => e.change_type.startsWith('move_from:'))).toBe(true);
    expect(entries.some((e: { change_type: string }) => e.change_type.startsWith('move_to:'))).toBe(true);
  });

  it('cancel in picker closes the move money flow', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));

    expect(screen.getByText(/Pick a source category/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(screen.queryByText(/Pick a source category/i)).not.toBeInTheDocument();
    expect(mockUpsertAssignment).not.toHaveBeenCalled();
  });

  it('cancel in confirm step closes the move money flow without saving', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));
    fireEvent.click(document.querySelector('.picker-item') as HTMLElement);

    expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(screen.queryByRole('button', { name: /Confirm/i })).not.toBeInTheDocument();
    expect(mockUpsertAssignment).not.toHaveBeenCalled();
  });

  it('plan refreshes after a successful move', async () => {
    const { default: Plan } = await import('../../src/screens/Plan');
    render(<Plan />);

    const row = await screen.findByRole('button', { name: /Groceries/i });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /Move Money/i }));
    fireEvent.click(document.querySelector('.picker-item') as HTMLElement);

    const callsBefore = mockFetchBudgetCategories.mock.calls.length;
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() =>
      expect(mockFetchBudgetCategories.mock.calls.length).toBeGreaterThan(callsBefore)
    );
  });
});
