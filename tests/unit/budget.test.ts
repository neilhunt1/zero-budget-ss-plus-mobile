import { describe, it, expect } from 'vitest';
import { buildGroupedBudget } from '../../src/api/budget';
import { BudgetCategory, BudgetAssignment } from '../../src/types/index';

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

function makeAssignment(category: string, assigned: number, month = '2025-04'): BudgetAssignment {
  return { month, category, assigned, _rowIndex: 502 };
}

// ─── buildGroupedBudget ───────────────────────────────────────────────────────

describe('buildGroupedBudget', () => {
  it('returns one group per unique category_group', () => {
    const categories = [
      makeCategory({ category: 'Groceries', category_group: 'Food & Dining' }),
      makeCategory({ category: 'Gas', category_group: 'Transportation' }),
    ];
    const result = buildGroupedBudget(categories, [], new Map());
    expect(result).toHaveLength(2);
    expect(result.map((g) => g.groupName)).toContain('Food & Dining');
    expect(result.map((g) => g.groupName)).toContain('Transportation');
  });

  it('computes available = assigned − activity', () => {
    const categories = [makeCategory({ category: 'Groceries' })];
    const assignments = [makeAssignment('Groceries', 500)];
    const activity = new Map([['Groceries', 320]]);

    const result = buildGroupedBudget(categories, assignments, activity);
    const groceries = result[0].subgroups[0].categories[0];

    expect(groceries.assigned).toBe(500);
    expect(groceries.activity).toBe(320);
    expect(groceries.available).toBe(180);
  });

  it('defaults assigned and activity to 0 when not provided', () => {
    const categories = [makeCategory({ category: 'Groceries' })];
    const result = buildGroupedBudget(categories, [], new Map());
    const cat = result[0].subgroups[0].categories[0];

    expect(cat.assigned).toBe(0);
    expect(cat.activity).toBe(0);
    expect(cat.available).toBe(0);
  });

  it('correctly sums group totals across multiple categories', () => {
    const categories = [
      makeCategory({ category: 'Groceries', sort_order: 1 }),
      makeCategory({ category: 'Dining Out', sort_order: 2 }),
    ];
    const assignments = [makeAssignment('Groceries', 500), makeAssignment('Dining Out', 200)];
    const activity = new Map([['Groceries', 400], ['Dining Out', 150]]);

    const [group] = buildGroupedBudget(categories, assignments, activity);

    expect(group.totalAssigned).toBe(700);
    expect(group.totalActivity).toBe(550);
    expect(group.totalAvailable).toBe(150);
  });

  it('places categories without a subgroup under an empty-string subgroup key', () => {
    const categories = [makeCategory({ category: 'Groceries', category_subgroup: '' })];
    const result = buildGroupedBudget(categories, [], new Map());
    const [subgroup] = result[0].subgroups;

    expect(subgroup.subgroupName).toBe('');
    expect(subgroup.categories[0].category).toBe('Groceries');
  });

  it('groups categories into correct subgroups', () => {
    const categories = [
      makeCategory({ category: 'Hockey', category_group: 'Kids & School', category_subgroup: 'Emory Activities' }),
      makeCategory({ category: 'Gymnastics', category_group: 'Kids & School', category_subgroup: 'Amara Activities' }),
    ];
    const result = buildGroupedBudget(categories, [], new Map());
    const [group] = result;

    expect(group.groupName).toBe('Kids & School');
    expect(group.subgroups).toHaveLength(2);
    const subgroupNames = group.subgroups.map((s) => s.subgroupName);
    expect(subgroupNames).toContain('Emory Activities');
    expect(subgroupNames).toContain('Amara Activities');
  });

  it('handles overspent categories (available goes negative)', () => {
    const categories = [makeCategory({ category: 'Dining Out' })];
    const assignments = [makeAssignment('Dining Out', 100)];
    const activity = new Map([['Dining Out', 175]]);

    const result = buildGroupedBudget(categories, assignments, activity);
    const cat = result[0].subgroups[0].categories[0];

    expect(cat.available).toBe(-75);
    expect(result[0].totalAvailable).toBe(-75);
  });
});
