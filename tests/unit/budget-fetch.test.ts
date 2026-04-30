import { describe, it, expect, vi } from 'vitest';
import { fetchBudgetCategories, fetchMonthAssignments, upsertAssignment, fetchReadyToAssign, appendLogEntry, fetchCategoryCalcs, applyTemplate } from '../../src/api/budget';
import type { BudgetCategory, BudgetAssignment } from '../../src/types';
import type { SheetsClient } from '../../src/api/client';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockClient(values: string[][]): SheetsClient {
  return {
    getValues: vi.fn().mockResolvedValue({ values }),
    updateValues: vi.fn().mockResolvedValue(undefined),
    appendValues: vi.fn().mockResolvedValue(undefined),
    batchUpdateValues: vi.fn().mockResolvedValue(undefined),
    batchUpdate: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn(),
  } as unknown as SheetsClient;
}

function makeCategory(overrides: Partial<BudgetCategory> = {}): BudgetCategory {
  return {
    category_group: 'Food',
    category_subgroup: '',
    category: 'Groceries',
    category_type: 'fluid',
    monthly_template_amount: 500,
    sort_order: 1,
    active: true,
    _rowIndex: 7,
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<BudgetAssignment> = {}): BudgetAssignment {
  return {
    month: '2026-04',
    category: 'Groceries',
    assigned: 200,
    source: 'manual',
    _rowIndex: 509,
    ...overrides,
  };
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

// ─── fetchReadyToAssign ───────────────────────────────────────────────────────

describe('fetchReadyToAssign', () => {
  it('parses a plain numeric value', async () => {
    const client = mockClient([['1234.56']]);
    expect(await fetchReadyToAssign(client)).toBe(1234.56);
  });

  it('strips a leading apostrophe before parsing', async () => {
    const client = mockClient([[`'567.89`]]);
    expect(await fetchReadyToAssign(client)).toBe(567.89);
  });

  it('returns 0 when the cell is empty', async () => {
    const client = mockClient([]);
    expect(await fetchReadyToAssign(client)).toBe(0);
  });

  it('returns 0 when the cell contains a non-numeric string', async () => {
    const client = mockClient([['N/A']]);
    expect(await fetchReadyToAssign(client)).toBe(0);
  });

  it('handles negative values', async () => {
    const client = mockClient([['-250']]);
    expect(await fetchReadyToAssign(client)).toBe(-250);
  });
});

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
    const existing = { month: '2025-04', category: 'Groceries', assigned: 400, source: 'manual', _rowIndex: 510 };
    await upsertAssignment(client, '2025-04', 'Groceries', 500, existing);
    expect(client.updateValues).toHaveBeenCalledWith(
      'Budget!A510:D510',
      [['2025-04', 'Groceries', 500, 'manual']]
    );
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('calls appendValues when no existing assignment is provided', async () => {
    const client = mockClient([]);
    await upsertAssignment(client, '2025-04', 'Gas', 75);
    expect(client.appendValues).toHaveBeenCalledWith(
      'Budget!A509',
      [['2025-04', 'Gas', 75, 'manual']]
    );
    expect(client.updateValues).not.toHaveBeenCalled();
  });
});

// ─── appendLogEntry ───────────────────────────────────────────────────────────

describe('appendLogEntry', () => {
  it('appends a log row to Budget_Log with correct fields', async () => {
    const client = mockClient([]);
    await appendLogEntry(client, '2026-04', 'Groceries', 100, 'manual');
    expect(client.appendValues).toHaveBeenCalledWith(
      'Budget_Log!A2',
      [[expect.any(String), '2026-04', 'Groceries', 100, 'manual', '']]
    );
  });

  it('uses empty string as default note', async () => {
    const client = mockClient([]);
    await appendLogEntry(client, '2026-04', 'Groceries', 50, 'manual');
    const [[, [row]]] = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(row[5]).toBe('');
  });

  it('includes the note when provided', async () => {
    const client = mockClient([]);
    await appendLogEntry(client, '2026-04', 'Gas', -50, 'move_from:Groceries', 'rebalance');
    const [[, [row]]] = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(row[4]).toBe('move_from:Groceries');
    expect(row[5]).toBe('rebalance');
  });

  it('records the timestamp as an ISO string', async () => {
    const client = mockClient([]);
    const before = new Date().toISOString();
    await appendLogEntry(client, '2026-04', 'Groceries', 100, 'manual');
    const after = new Date().toISOString();
    const [[, [row]]] = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(row[0] >= before && row[0] <= after).toBe(true);
  });

  it('passes negative deltas for decreases', async () => {
    const client = mockClient([]);
    await appendLogEntry(client, '2026-04', 'Dining Out', -200, 'manual');
    const [[, [row]]] = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls;
    expect(row[3]).toBe(-200);
  });
});

// ─── fetchCategoryCalcs ───────────────────────────────────────────────────────

// Budget_Calcs columns: month, category, activity, assigned, available
function calcsRow(month: string, category: string, activity: string, assigned: string, available: string): string[] {
  return [month, category, activity, assigned, available];
}

describe('fetchCategoryCalcs', () => {
  it('returns empty map when sheet has no data rows', async () => {
    const client = mockClient([]);
    expect((await fetchCategoryCalcs(client, '2025-04')).size).toBe(0);
  });

  it('skips the header row and filters by month', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'], // header
      calcsRow('2025-03', 'Groceries', '300', '400', '100'),
      calcsRow('2025-04', 'Groceries', '320', '500', '180'),
      calcsRow('2025-04', 'Dining Out', '150', '200', '50'),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    expect(result.size).toBe(2);
    expect(result.has('Groceries')).toBe(true);
    expect(result.has('Dining Out')).toBe(true);
    expect(result.has('Groceries')).toBe(true);
    const groceries = result.get('Groceries')!;
    expect(groceries.activity).toBe(320);
    expect(groceries.available).toBe(180);
  });

  it('parses activity and available as floats', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'],
      calcsRow('2025-04', 'Gas', '45.75', '100', '54.25'),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    const gas = result.get('Gas')!;
    expect(gas.activity).toBe(45.75);
    expect(gas.available).toBe(54.25);
  });

  it('defaults activity and available to 0 when values are empty', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'],
      calcsRow('2025-04', 'Haircuts', '', '', ''),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    const haircuts = result.get('Haircuts')!;
    expect(haircuts.activity).toBe(0);
    expect(haircuts.available).toBe(0);
  });

  it('handles negative available (overspent with rollover)', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'],
      calcsRow('2025-04', 'Dining Out', '250', '100', '-150'),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    expect(result.get('Dining Out')!.available).toBe(-150);
  });

  it('returns empty map when no rows match the month', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'],
      calcsRow('2025-03', 'Groceries', '300', '400', '100'),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    expect(result.size).toBe(0);
  });

  it('skips rows with an empty category', async () => {
    const client = mockClient([
      ['month', 'category', 'activity', 'assigned', 'available'],
      calcsRow('2025-04', '', '100', '200', '100'),
    ]);
    const result = await fetchCategoryCalcs(client, '2025-04');
    expect(result.size).toBe(0);
  });
});

// ─── applyTemplate ────────────────────────────────────────────────────────────

describe('applyTemplate', () => {
  it('does nothing when no categories have a template amount', async () => {
    const client = mockClient([]);
    await applyTemplate(client, '2026-04', [makeCategory({ monthly_template_amount: 0 })], []);
    expect(client.batchUpdateValues).not.toHaveBeenCalled();
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it('appends new rows for categories with no existing assignment', async () => {
    const client = mockClient([]);
    await applyTemplate(client, '2026-04', [makeCategory()], []);
    expect(client.appendValues).toHaveBeenCalledWith(
      expect.stringContaining('Budget!'),
      [['2026-04', 'Groceries', 500, 'template']]
    );
    expect(client.batchUpdateValues).not.toHaveBeenCalled();
  });

  it('uses batchUpdateValues for categories with an existing assignment', async () => {
    const client = mockClient([]);
    const existing = makeAssignment({ _rowIndex: 510 });
    await applyTemplate(client, '2026-04', [makeCategory()], [existing]);
    expect(client.batchUpdateValues).toHaveBeenCalledWith([
      {
        range: 'Budget!A510:D510',
        values: [['2026-04', 'Groceries', 500, 'template']],
      },
    ]);
    expect(client.appendValues).not.toHaveBeenCalledWith(
      expect.stringContaining('Budget!'),
      expect.anything()
    );
  });

  it('batches new and updated assignments in the same call', async () => {
    const client = mockClient([]);
    const cats = [
      makeCategory({ category: 'Groceries', monthly_template_amount: 500 }),
      makeCategory({ category: 'Gas', monthly_template_amount: 100 }),
    ];
    const existing = makeAssignment({ category: 'Groceries', _rowIndex: 510 });
    await applyTemplate(client, '2026-04', cats, [existing]);

    expect(client.batchUpdateValues).toHaveBeenCalledWith([
      { range: 'Budget!A510:D510', values: [['2026-04', 'Groceries', 500, 'template']] },
    ]);
    expect(client.appendValues).toHaveBeenCalledWith(
      expect.stringContaining('Budget!'),
      [['2026-04', 'Gas', 100, 'template']]
    );
  });

  it('appends all log entries in a single call', async () => {
    const client = mockClient([]);
    const cats = [
      makeCategory({ category: 'Groceries', monthly_template_amount: 500 }),
      makeCategory({ category: 'Gas', monthly_template_amount: 100 }),
    ];
    await applyTemplate(client, '2026-04', cats, []);

    const logCall = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls.find(
      ([range]: [string]) => range.startsWith('Budget_Log')
    );
    expect(logCall).toBeDefined();
    expect(logCall[1]).toHaveLength(2);
  });

  it('skips categories with template amount of 0', async () => {
    const client = mockClient([]);
    const cats = [
      makeCategory({ category: 'Groceries', monthly_template_amount: 500 }),
      makeCategory({ category: 'Savings', monthly_template_amount: 0 }),
    ];
    await applyTemplate(client, '2026-04', cats, []);

    const budgetCall = (client.appendValues as ReturnType<typeof vi.fn>).mock.calls.find(
      ([range]: [string]) => range.startsWith('Budget!')
    );
    expect(budgetCall[1]).toHaveLength(1);
    expect(budgetCall[1][0][1]).toBe('Groceries');
  });
});
