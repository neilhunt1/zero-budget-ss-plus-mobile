import { describe, it, expect, vi } from 'vitest';
import { fetchBudgetCategories, fetchMonthAssignments, upsertAssignment } from '../../src/api/budget';
import type { SheetsClient } from '../../src/api/client';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockClient(values: string[][]): SheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue({ values }),
    updateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue(undefined),
    batchUpdate: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn(),
  } as unknown as SheetsClient;
}

// Column order: category_group, category_subgroup, category, category_type,
//               monthly_template_amount, sort_order, active
function categoryRow(
  group: string,
  subgroup: string,
  category: string,
  type = 'fluid',
  template = '0',
  sortOrder = '1',
  active = 'TRUE'
): string[] {
  return [group, subgroup, category, type, template, sortOrder, active];
}

// ─── fetchBudgetCategories ────────────────────────────────────────────────────

describe('fetchBudgetCategories', () => {
  it('returns empty array when sheet has no data', async () => {
    const client = mockClient([]);
    expect(await fetchBudgetCategories(client)).toEqual([]);
  });

  it('filters out rows with no category name', async () => {
    const client = mockClient([
      categoryRow('Food', '', 'Groceries'),
      ['Food', '', '', 'fluid', '0', '2', 'TRUE'], // empty category name
    ]);
    const result = await fetchBudgetCategories(client);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Groceries');
  });

  it('filters out inactive categories', async () => {
    const client = mockClient([
      categoryRow('Food', '', 'Groceries', 'fluid', '0', '1', 'TRUE'),
      categoryRow('Food', '', 'Old Category', 'fluid', '0', '2', 'FALSE'),
    ]);
    const result = await fetchBudgetCategories(client);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Groceries');
  });

  it('sorts by sort_order ascending', async () => {
    const client = mockClient([
      categoryRow('Food', '', 'Dining Out', 'fluid', '0', '3'),
      categoryRow('Food', '', 'Groceries', 'fluid', '0', '1'),
      categoryRow('Food', '', 'CSA', 'savings_target', '0', '2'),
    ]);
    const result = await fetchBudgetCategories(client);
    expect(result.map((c) => c.category)).toEqual(['Groceries', 'CSA', 'Dining Out']);
  });

  it('parses all columns correctly', async () => {
    const client = mockClient([
      categoryRow('Transportation', 'Auto', 'Gas', 'fluid', '150', '5', 'TRUE'),
    ]);
    const [cat] = await fetchBudgetCategories(client);
    expect(cat.category_group).toBe('Transportation');
    expect(cat.category_subgroup).toBe('Auto');
    expect(cat.category).toBe('Gas');
    expect(cat.category_type).toBe('fluid');
    expect(cat.monthly_template_amount).toBe(150);
    expect(cat.sort_order).toBe(5);
    expect(cat.active).toBe(true);
  });

  it('treats active=FALSE (case-insensitive) as inactive', async () => {
    const client = mockClient([
      categoryRow('Food', '', 'Old', 'fluid', '0', '1', 'false'),
    ]);
    expect(await fetchBudgetCategories(client)).toHaveLength(0);
  });

  it('defaults numeric fields to 0 when unparseable', async () => {
    const client = mockClient([
      ['Food', '', 'Groceries', 'fluid', 'n/a', '', 'TRUE'],
    ]);
    const [cat] = await fetchBudgetCategories(client);
    expect(cat.monthly_template_amount).toBe(0);
    expect(cat.sort_order).toBe(0);
  });
});

// ─── fetchMonthAssignments ────────────────────────────────────────────────────

describe('fetchMonthAssignments', () => {
  // Assignment rows: month, category, assigned
  it('returns only assignments for the requested month', async () => {
    const client = mockClient([
      ['2025-03', 'Groceries', '400'],
      ['2025-04', 'Groceries', '500'],
      ['2025-04', 'Dining Out', '200'],
    ]);
    const result = await fetchMonthAssignments(client, '2025-04');
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.month === '2025-04')).toBe(true);
  });

  it('returns empty array when no assignments exist for the month', async () => {
    const client = mockClient([['2025-03', 'Groceries', '400']]);
    expect(await fetchMonthAssignments(client, '2025-04')).toEqual([]);
  });

  it('returns empty array when sheet has no assignment rows', async () => {
    const client = mockClient([]);
    expect(await fetchMonthAssignments(client, '2025-04')).toEqual([]);
  });

  it('parses assigned amount as a float', async () => {
    const client = mockClient([['2025-04', 'Groceries', '523.75']]);
    const [assignment] = await fetchMonthAssignments(client, '2025-04');
    expect(assignment.assigned).toBe(523.75);
  });

  it('defaults assigned to 0 when value is missing', async () => {
    const client = mockClient([['2025-04', 'Groceries', '']]);
    const [assignment] = await fetchMonthAssignments(client, '2025-04');
    expect(assignment.assigned).toBe(0);
  });
});

// ─── upsertAssignment ─────────────────────────────────────────────────────────

describe('upsertAssignment', () => {
  it('calls updateValues when an existing assignment is provided', async () => {
    const client = mockClient([]);
    const existing = { month: '2025-04', category: 'Groceries', assigned: 400, _rowIndex: 510 };
    await upsertAssignment(client, '2025-04', 'Groceries', 500, existing);
    expect(client.updateValues).toHaveBeenCalledWith(
      'Budget!A510:C510',
      [['2025-04', 'Groceries', 500]]
    );
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('calls appendValues when no existing assignment is provided', async () => {
    const client = mockClient([]);
    await upsertAssignment(client, '2025-04', 'Gas', 75);
    expect(client.appendValues).toHaveBeenCalledWith(
      'Budget!A503',
      [['2025-04', 'Gas', 75]]
    );
    expect(client.updateValues).not.toHaveBeenCalled();
  });
});
