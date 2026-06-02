/**
 * plan-groups.spec.ts
 *
 * E2E tests for group budgeting (by_group mode) on the Plan screen.
 *
 * beforeAll seeds the test sheet:
 *   - Sets "Food & Dining" to by_group with a $2,000 template amount
 *   - Writes a $1,500 group assignment for the current month
 * State is left in place after the run; the next beforeAll clears and resets it.
 *
 * Requires: setup:test has been run at least once so the Groups tab exists.
 * GOOGLE_SHEET_ID in .env.test must point to BTSZB-Test.
 */

import { test, expect, Page } from '@playwright/test';
import { injectServiceAccountAuth, getServiceAccountToken } from './fixtures/auth';
import { seedGroupForTest, currentMonth } from './helpers/group-seed';

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const TEST_GROUP = 'Food & Dining';
const GROUP_BUDGET = 1500;
const GROUP_TEMPLATE = 2000;
const MONTH = currentMonth();

// ─── Seed once before all group tests ────────────────────────────────────────

test.beforeAll(async () => {
  const { access_token } = await getServiceAccountToken();
  await seedGroupForTest(access_token, SHEET_ID, TEST_GROUP, {
    budgetAmount: GROUP_BUDGET,
    templateAmount: GROUP_TEMPLATE,
    month: MONTH,
  });
});

// ─── Auth + navigation shared setup ──────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await injectServiceAccountAuth(page);
});

/** Navigate to Plan and wait for the full sync to complete. */
async function gotoAndSync(page: Page): Promise<void> {
  await page.goto('./#/plan');
  // Wait for at least one budget row to appear — proves sync completed
  await expect(page.getByTestId('budget-row').first()).toBeVisible({ timeout: 40_000 });
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

test.describe('Plan screen — group budgeting sidebar (desktop)', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('by_group group shows a G badge in the sidebar', async ({ page }) => {
    await gotoAndSync(page);

    // Find the sidebar tab for Food & Dining
    const tab = page.locator('.plan-group-tab', { hasText: TEST_GROUP });
    await expect(tab).toBeVisible();
    await expect(tab.locator('.plan-group-tab-badge')).toHaveText('G');
  });

  test('by_category group does NOT show a G badge', async ({ page }) => {
    await gotoAndSync(page);

    // Any other group (Home, Transportation, etc.) should not have a badge
    const otherTabs = page.locator('.plan-group-tab').filter({
      hasNot: page.locator('.plan-group-tab', { hasText: TEST_GROUP }),
    });
    // At least one other group exists and none of them have a badge
    await expect(otherTabs.first()).toBeVisible();
    for (const tab of await otherTabs.all()) {
      await expect(tab.locator('.plan-group-tab-badge')).not.toBeAttached();
    }
  });

  test('sidebar shows groupAvailable (not sum of category availables) for by_group group', async ({ page }) => {
    await gotoAndSync(page);

    // The group available = groupAssigned ($1,500) minus totalActivity
    // We seeded $1,500 budget with unknown activity — just verify it renders a dollar amount
    const tab = page.locator('.plan-group-tab', { hasText: TEST_GROUP });
    const total = tab.locator('.plan-group-tab-total');
    await expect(total).toBeVisible();
    await expect(total).toHaveText(/\$[\d,]+/);
  });
});

// ─── Group Envelope row ───────────────────────────────────────────────────────

test.describe('Plan screen — Group Envelope row', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('Group Envelope row appears at the top of a by_group group', async ({ page }) => {
    await gotoAndSync(page);

    // Select Food & Dining in the sidebar to show its detail
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    const envelope = page.locator('.budget-row--group-envelope');
    await expect(envelope).toBeVisible();
    await expect(envelope).toContainText('Group Envelope');
  });

  test('Group Envelope row shows seeded assigned amount', async ({ page }) => {
    await gotoAndSync(page);
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    const envelope = page.locator('.budget-row--group-envelope');
    // Seeded $1,500 group budget
    await expect(envelope).toContainText('$1,500');
  });

  test('category rows inside by_group group have actuals-only style (no overspent class)', async ({ page }) => {
    await gotoAndSync(page);
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    const categoryRows = page.locator('.budget-row--actuals-only');
    // Food & Dining has at least one category (Groceries, Dining Out, etc.)
    await expect(categoryRows.first()).toBeVisible();

    // None should carry the overspent class — group mode suppresses per-category red
    const count = await categoryRows.count();
    for (let i = 0; i < count; i++) {
      await expect(categoryRows.nth(i)).not.toHaveClass(/overspent/);
    }
  });

  test('category rows show only category name and activity columns (not assigned/available)', async ({ page }) => {
    await gotoAndSync(page);
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    // Actuals-only rows render 4 col spans: name, empty, activity, empty
    // The empty spans have no text content — we assert there's no dollar sign in positions 1 and 3
    const firstRow = page.locator('.budget-row--actuals-only').first();
    await expect(firstRow).toBeVisible();
    const spans = firstRow.locator('.col-num');
    // First and last col-num spans should be empty (no assigned or available dollar amounts)
    await expect(spans.nth(0)).toBeEmpty();
    await expect(spans.nth(2)).toBeEmpty();
  });

  test('clicking Group Envelope row opens the assignment sheet', async ({ page }) => {
    await gotoAndSync(page);
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    await page.locator('.budget-row--group-envelope').click();

    const sheet = page.locator('.assign-sheet');
    await expect(sheet).toBeVisible({ timeout: 3_000 });
    await expect(sheet).toContainText(TEST_GROUP);
    await expect(page.locator('#assign-group-input')).toBeVisible();
  });

  test('saving a new group budget amount updates the display', async ({ page }) => {
    await gotoAndSync(page);
    await page.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();

    // Open the group budget editor
    await page.locator('.budget-row--group-envelope').click();
    await expect(page.locator('#assign-group-input')).toBeVisible({ timeout: 3_000 });

    // Change the budget to $1,800
    await page.locator('#assign-group-input').fill('1800');
    await page.getByRole('button', { name: /^Save$/i }).click();

    // Sheet should close and the envelope row should show the updated amount
    await expect(page.locator('.assign-sheet')).not.toBeAttached({ timeout: 10_000 });
    await expect(page.locator('.budget-row--group-envelope')).toContainText('$1,800');
  });
});

// ─── Apply Template ───────────────────────────────────────────────────────────

test.describe('Plan screen — Apply Template with group budget', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('Apply Template button is enabled when a by_group group has a template amount', async ({ page }) => {
    // Group is seeded with templateAmount: 2000 (by_group), so button should be enabled
    // even if no individual categories have template amounts
    await gotoAndSync(page);
    const btn = page.getByRole('button', { name: /Apply Template/i });
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  });
});

// ─── Mobile layout ────────────────────────────────────────────────────────────

test.describe('Plan screen — group budgeting mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 Pro dimensions

  test('group header shows groupAvailable balance for by_group group', async ({ page }) => {
    await gotoAndSync(page);

    // On mobile, all groups are visible stacked — find the Food & Dining group header
    const groupHeader = page.locator('.group-header', { hasText: TEST_GROUP });
    await expect(groupHeader).toBeVisible({ timeout: 5_000 });

    // The header should show a dollar amount (the group available, not a progress bar)
    await expect(groupHeader.locator('.group-total')).toHaveText(/\$[\d,]+/);
  });

  test('Group Envelope row is visible and tappable on mobile', async ({ page }) => {
    await gotoAndSync(page);

    const envelope = page.locator('.budget-row--group-envelope').first();
    await expect(envelope).toBeVisible({ timeout: 5_000 });
    await envelope.click();

    await expect(page.locator('.assign-sheet')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#assign-group-input')).toBeVisible();
  });
});
