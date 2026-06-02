import { describe, it, expect } from 'vitest';
import { buildGroupedBudget } from '../../src/api/budget';
import { BudgetCategory, BudgetAssignment, CategoryCalcs, BudgetGroup, GroupBudgetAssignment, BudgetCalcEntry } from '../../src/types/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCategory(overrides: Partial<BudgetCategory> = {}): BudgetCategory {
  return {
    category_group: 'Food & Dining',
    category_subgroup: '',
    category: 'Groceries',
    category_type: 'fluid',
    monthly_template_amount: 0,
    sort_order: 1,
    active: true,
    _rowIndex: 2,
    ...overrides,
  };
}

function makeAssignment(category: string, assigned: number, month = '2026-07'): BudgetAssignment {
  return { month, category, assigned, source: 'manual', _rowIndex: 509 };
}

function makeGroupAssignment(category_group: string, assigned: number, month = '2026-07'): GroupBudgetAssignment {
  return { month, category_group, assigned, source: 'manual', _rowIndex: 510 };
}

function makeGroup(overrides: Partial<BudgetGroup> = {}): BudgetGroup {
  return {
    group_name: 'Food & Dining',
    budget_type: 'by_group',
    rollover: false,
    rollover_start_month: '',
    _rowIndex: 2,
    ...overrides,
  };
}

function makeCalcEntry(month: string, category: string, activity: number, available = 0): BudgetCalcEntry {
  return { month, category, activity, available };
}

const CURRENT_MONTH = '2026-07';

// ─── by_category (existing behavior, backward compat) ─────────────────────────

describe('buildGroupedBudget — by_category', () => {
  it('preserves existing totals when no group metadata provided', () => {
    const cats = [makeCategory({ category: 'Groceries' }), makeCategory({ category: 'Dining', sort_order: 2 })];
    const assignments = [makeAssignment('Groceries', 800), makeAssignment('Dining', 200)];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 600, available: 200 }],
      ['Dining', { activity: 150, available: 50 }],
    ]);

    const result = buildGroupedBudget(cats, assignments, calcMap);
    expect(result).toHaveLength(1);
    const group = result[0];
    expect(group.budgetType).toBe('by_category');
    expect(group.totalAssigned).toBe(1000);
    expect(group.totalActivity).toBe(750);
    expect(group.totalAvailable).toBe(250);
    expect(group.groupAssigned).toBe(0);
    expect(group.groupAvailable).toBe(250); // same as totalAvailable for by_category
  });
});

// ─── by_group — simple (no rollover) ──────────────────────────────────────────

describe('buildGroupedBudget — by_group without rollover', () => {
  it('computes groupAvailable as groupAssigned minus total category activity', () => {
    const cats = [
      makeCategory({ category: 'Groceries' }),
      makeCategory({ category: 'Dining', sort_order: 2 }),
    ];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 600, available: 0 }],
      ['Dining', { activity: 300, available: 0 }],
    ]);
    const groups = [makeGroup()];
    const groupAssignments = [makeGroupAssignment('Food & Dining', 2000)];

    const result = buildGroupedBudget(cats, [], calcMap, groups, groupAssignments, [], CURRENT_MONTH);
    const group = result[0];
    expect(group.budgetType).toBe('by_group');
    expect(group.groupAssigned).toBe(2000);
    expect(group.groupAvailable).toBe(1100); // 2000 - 600 - 300
  });

  it('groupAvailable goes negative when spending exceeds group budget', () => {
    const cats = [makeCategory({ category: 'Groceries' })];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 2500, available: 0 }],
    ]);
    const groups = [makeGroup()];
    const groupAssignments = [makeGroupAssignment('Food & Dining', 2000)];

    const result = buildGroupedBudget(cats, [], calcMap, groups, groupAssignments, [], CURRENT_MONTH);
    expect(result[0].groupAvailable).toBe(-500);
  });

  it('groupAvailable is zero when no group assignment exists', () => {
    const cats = [makeCategory({ category: 'Groceries' })];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 100, available: 0 }],
    ]);
    const groups = [makeGroup()];
    // No group assignment provided

    const result = buildGroupedBudget(cats, [], calcMap, groups, [], [], CURRENT_MONTH);
    expect(result[0].groupAssigned).toBe(0);
    expect(result[0].groupAvailable).toBe(-100); // 0 - 100
  });

  it('category rows have no overspent semantics — available is informational', () => {
    const cats = [
      makeCategory({ category: 'Groceries' }),
      makeCategory({ category: 'Dining', sort_order: 2 }),
    ];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 800, available: -200 }], // individual overspent
      ['Dining', { activity: 50, available: 350 }],       // individual underspent
    ]);
    const groups = [makeGroup()];
    const groupAssignments = [makeGroupAssignment('Food & Dining', 2000)];

    const result = buildGroupedBudget(cats, [], calcMap, groups, groupAssignments, [], CURRENT_MONTH);
    const group = result[0];
    // Net group is fine even though Groceries is individually overspent
    expect(group.groupAvailable).toBe(1150); // 2000 - 800 - 50
    expect(group.totalAvailable).toBe(150);  // sum of individual availables (-200 + 350)
  });
});

// ─── by_group — rollover ──────────────────────────────────────────────────────

describe('buildGroupedBudget — by_group with rollover', () => {
  it('sums activity from rollover_start_month through current month', () => {
    const cats = [makeCategory({ category: 'Christmas Gifts', category_group: 'Gifts & Holidays🎁' })];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Christmas Gifts', { activity: 150, available: 0 }], // Oct activity
    ]);
    const allCalcs: BudgetCalcEntry[] = [
      makeCalcEntry('2026-10', 'Christmas Gifts', 200),
      makeCalcEntry('2026-11', 'Christmas Gifts', 300),
      makeCalcEntry('2026-12', 'Christmas Gifts', 150), // current month
    ];
    const groups = [
      makeGroup({
        group_name: 'Gifts & Holidays🎁',
        rollover: true,
        rollover_start_month: '2026-10',
      }),
    ];
    const groupAssignments = [makeGroupAssignment('Gifts & Holidays🎁', 1200, '2026-12')];

    const result = buildGroupedBudget(
      cats, [], calcMap, groups, groupAssignments, allCalcs, '2026-12'
    );
    const group = result[0];
    // Cumulative activity Oct+Nov+Dec = 200+300+150 = 650; available = 1200 - 650 = 550
    expect(group.groupAvailable).toBe(550);
  });

  it('excludes activity before rollover_start_month', () => {
    const cats = [makeCategory({ category: 'Christmas Gifts', category_group: 'Gifts & Holidays🎁' })];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Christmas Gifts', { activity: 100, available: 0 }],
    ]);
    const allCalcs: BudgetCalcEntry[] = [
      makeCalcEntry('2026-09', 'Christmas Gifts', 9999), // before rollover — must be excluded
      makeCalcEntry('2026-10', 'Christmas Gifts', 400),
      makeCalcEntry('2026-11', 'Christmas Gifts', 400),
    ];
    const groups = [
      makeGroup({
        group_name: 'Gifts & Holidays🎁',
        rollover: true,
        rollover_start_month: '2026-10',
      }),
    ];
    const groupAssignments = [makeGroupAssignment('Gifts & Holidays🎁', 1200, '2026-11')];

    const result = buildGroupedBudget(
      cats, [], calcMap, groups, groupAssignments, allCalcs, '2026-11'
    );
    expect(result[0].groupAvailable).toBe(400); // 1200 - 400 - 400 = 400
  });

  it('excludes activity from other groups during rollover calculation', () => {
    const cats = [
      makeCategory({ category: 'Christmas Gifts', category_group: 'Gifts & Holidays🎁' }),
      makeCategory({ category: 'Groceries', category_group: 'Food & Dining', sort_order: 2 }),
    ];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Christmas Gifts', { activity: 100, available: 0 }],
      ['Groceries', { activity: 500, available: 0 }],
    ]);
    const allCalcs: BudgetCalcEntry[] = [
      makeCalcEntry('2026-10', 'Christmas Gifts', 200),
      makeCalcEntry('2026-10', 'Groceries', 9999), // different group — must be excluded
    ];
    const groups = [
      makeGroup({
        group_name: 'Gifts & Holidays🎁',
        rollover: true,
        rollover_start_month: '2026-10',
      }),
      makeGroup({ group_name: 'Food & Dining', budget_type: 'by_category', rollover: false }),
    ];
    const groupAssignments = [makeGroupAssignment('Gifts & Holidays🎁', 1200, '2026-10')];

    const result = buildGroupedBudget(
      cats, [], calcMap, groups, groupAssignments, allCalcs, '2026-10'
    );
    const xmasGroup = result.find((g) => g.groupName === 'Gifts & Holidays🎁')!;
    expect(xmasGroup.groupAvailable).toBe(1000); // 1200 - 200 (only Christmas activity)
  });
});

// ─── mixed groups ─────────────────────────────────────────────────────────────

describe('buildGroupedBudget — mixed by_category and by_group groups', () => {
  it('each group uses its own budget mode independently', () => {
    const cats = [
      makeCategory({ category: 'Groceries', category_group: 'Food & Dining' }),
      makeCategory({ category: 'Mortgage', category_group: 'Home', sort_order: 2 }),
    ];
    const calcMap = new Map<string, CategoryCalcs>([
      ['Groceries', { activity: 600, available: 200 }],
      ['Mortgage', { activity: 2500, available: -100 }],
    ]);
    const groups = [
      makeGroup({ group_name: 'Food & Dining', budget_type: 'by_group', rollover: false }),
      makeGroup({ group_name: 'Home', budget_type: 'by_category', rollover: false }),
    ];
    const groupAssignments = [makeGroupAssignment('Food & Dining', 2000)];

    const result = buildGroupedBudget(cats, [], calcMap, groups, groupAssignments, [], CURRENT_MONTH);

    const food = result.find((g) => g.groupName === 'Food & Dining')!;
    const home = result.find((g) => g.groupName === 'Home')!;

    expect(food.budgetType).toBe('by_group');
    expect(food.groupAvailable).toBe(1400); // 2000 - 600

    expect(home.budgetType).toBe('by_category');
    expect(home.groupAvailable).toBe(-100); // same as totalAvailable
    expect(home.totalAvailable).toBe(-100);
  });
});
