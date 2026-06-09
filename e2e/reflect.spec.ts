import { test, expect, type Page } from '@playwright/test';
import { injectServiceAccountAuth } from './fixtures/auth';

/**
 * Reflect screen E2E tests
 *
 * Seed data used (all dated in "last month" — always visible under the "Last Month" preset):
 *   seed-001  Amazon         $45.67   Uncategorized   regular   pending
 *   seed-002  Employer       $2500    income          income    (excluded from spend)
 *   seed-003  Transfer       $500     transfer        transfer  (excluded from spend)
 *   seed-004  Transfer       $500     transfer        transfer  (excluded from spend)
 *   seed-005  Whole Foods    $89.12   Food & Dining   regular   cleared
 *   seed-006  Netflix        $15.99   Uncategorized   regular   pending
 *   seed-007  Dining Out     $42.50   Food & Dining   regular   cleared
 *   seed-008  Target         $120.00  Uncategorized   regular   cleared
 *
 * Expected spend totals (transfers + income excluded):
 *   Food & Dining  $131.62  ($89.12 + $42.50)
 *   Uncategorized  $181.66  ($45.67 + $15.99 + $120.00)
 *   Grand total    $313.28
 */

const TOTAL = '$313';        // fmt() rounds to nearest dollar
const FOOD_TOTAL = '$132';   // $131.62 → $132
const UNCAT_TOTAL = '$182';  // $181.66 → $182

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function selectPreset(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
}

async function switchToBar(page: Page) {
  await page.getByTestId('chart-toggle').getByRole('button', { name: 'Bar' }).click();
}

async function switchToPie(page: Page) {
  await page.getByTestId('chart-toggle').getByRole('button', { name: 'Pie' }).click();
}

// ─── Global beforeEach: auth + navigate ───────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await injectServiceAccountAuth(page);
  await page.goto('./#/reflect');
  await expect(page.getByTestId('reflect-screen')).toBeVisible({ timeout: 10_000 });
});

// ─── Preset chips ─────────────────────────────────────────────────────────────

test.describe('time range presets', () => {
  test('all preset chips are visible', async ({ page }) => {
    for (const label of ['MTD', 'Last Month', '3 Mo.', 'YTD', 'Last Year', 'Custom']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
  });

  test('Last Month chip is active by default', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Last Month', exact: true }))
      .toHaveClass(/preset-chip--active/);
  });

  test('Custom preset shows date pickers', async ({ page }) => {
    await selectPreset(page, 'Custom');
    await expect(page.locator('input[type="date"]').first()).toBeVisible();
  });

  test('date range label appears next to chips for non-custom presets', async ({ page }) => {
    // The label should contain the year of last month (handles January year-wrap correctly)
    const lastMonthYear = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
      .getFullYear()
      .toString();
    await expect(page.locator('.preset-date-range')).toContainText(lastMonthYear);
  });
});

// ─── Bar chart ────────────────────────────────────────────────────────────────

test.describe('bar chart — Last Month (relative seed data)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000); // sync can take 20-30s; give headroom
    await selectPreset(page, 'Last Month');
    await switchToBar(page);
    // Wait for actual group data — this blocks until sync completes and data populates
    await expect(page.getByTestId('hbar-group').first()).toBeVisible({ timeout: 50_000 });
  });

  test('shows the correct number of groups', async ({ page }) => {
    // Food & Dining + Uncategorized = 2 groups
    await expect(page.getByTestId('hbar-group')).toHaveCount(2);
  });

  test('shows Uncategorized group with correct total', async ({ page }) => {
    const uncatGroup = page.getByTestId('hbar-group').filter({ hasText: 'Uncategorized' });
    await expect(uncatGroup).toBeVisible();
    await expect(uncatGroup).toContainText(UNCAT_TOTAL);
  });

  test('shows Food & Dining group with correct total', async ({ page }) => {
    const foodGroup = page.getByTestId('hbar-group').filter({ hasText: 'Food & Dining' });
    await expect(foodGroup).toBeVisible();
    await expect(foodGroup).toContainText(FOOD_TOTAL);
  });

  test('expanding Food & Dining shows its categories', async ({ page }) => {
    const foodGroup = page.getByTestId('hbar-group').filter({ hasText: 'Food & Dining' });
    await foodGroup.getByRole('button').click();

    await expect(page.getByText('Groceries 🛒')).toBeVisible();
    await expect(page.getByText('Dining Out 🧑‍🍳')).toBeVisible();
    await expect(page.getByText('$89')).toBeVisible(); // Whole Foods $89.12
    await expect(page.getByText('$43')).toBeVisible(); // Dining Out $42.50 → $43
  });

  test('excludes income and transfers', async ({ page }) => {
    await expect(page.getByTestId('hbar-chart')).not.toContainText('$2,500');
    await expect(page.getByTestId('hbar-chart')).not.toContainText('$500');
  });

  test('groups sorted by spend descending', async ({ page }) => {
    const groups = page.getByTestId('hbar-group');
    const first = await groups.nth(0).textContent();
    const second = await groups.nth(1).textContent();
    // Uncategorized ($182) > Food & Dining ($132)
    expect(first).toContain('Uncategorized');
    expect(second).toContain('Food & Dining');
  });
});

// ─── Pie chart ────────────────────────────────────────────────────────────────

test.describe('pie chart — Last Month (relative seed data)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000); // sync can take 20-30s; give headroom
    await selectPreset(page, 'Last Month');
    await switchToPie(page);
    // Wait for actual group rows — this blocks until sync + data are ready
    await expect(page.getByTestId('pie-group-row').first()).toBeVisible({ timeout: 50_000 });
  });

  test('shows total spend in the summary label', async ({ page }) => {
    await expect(page.getByTestId('pie-total')).toContainText(TOTAL);
  });

  test('shows both groups in the right-panel list', async ({ page }) => {
    await expect(page.getByTestId('pie-group-row').filter({ hasText: 'Uncategorized' })).toBeVisible();
    await expect(page.getByTestId('pie-group-row').filter({ hasText: 'Food & Dining' })).toBeVisible();
  });

  test('clicking a group row expands its categories', async ({ page }) => {
    await page.getByTestId('pie-group-row').filter({ hasText: 'Food & Dining' }).click();
    await expect(page.getByText('Groceries 🛒')).toBeVisible();
    await expect(page.getByText('Dining Out 🧑‍🍳')).toBeVisible();
  });

  test('clicking an expanded group again collapses it', async ({ page }) => {
    const foodRow = page.getByTestId('pie-group-row').filter({ hasText: 'Food & Dining' });
    await foodRow.click();
    await expect(page.getByText('Groceries 🛒')).toBeVisible();
    await foodRow.click();
    await expect(page.getByText('Groceries 🛒')).not.toBeVisible();
  });

  test('group amounts in right panel match expected totals', async ({ page }) => {
    await expect(page.getByTestId('pie-group-row').filter({ hasText: 'Food & Dining' }))
      .toContainText(FOOD_TOTAL);
    await expect(page.getByTestId('pie-group-row').filter({ hasText: 'Uncategorized' }))
      .toContainText(UNCAT_TOTAL);
  });
});

// ─── Chart toggle ─────────────────────────────────────────────────────────────

test.describe('chart type toggle', () => {
  test('switches between pie and bar', async ({ page }) => {
    test.setTimeout(60_000);
    await selectPreset(page, 'Last Month');
    // Wait for pie data before testing toggle
    await expect(page.getByTestId('pie-group-row').first()).toBeVisible({ timeout: 50_000 });

    await expect(page.getByTestId('pie-chart')).toBeVisible();
    await expect(page.getByTestId('hbar-chart')).not.toBeAttached();

    await switchToBar(page);
    await expect(page.getByTestId('hbar-chart')).toBeVisible();
    await expect(page.getByTestId('pie-chart')).not.toBeAttached();

    await switchToPie(page);
    await expect(page.getByTestId('pie-chart')).toBeVisible();
    await expect(page.getByTestId('hbar-chart')).not.toBeAttached();
  });
});
