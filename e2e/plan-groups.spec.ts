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

import { test, expect, Page, Browser } from '@playwright/test';
import { injectServiceAccountAuth, getServiceAccountToken } from './fixtures/auth';
import { seedGroupForTest, currentMonth } from './helpers/group-seed';

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const TEST_GROUP = 'Food & Dining';
const GROUP_BUDGET = 1500;
const GROUP_TEMPLATE = 2000;
const MONTH = currentMonth();
const SYNC_TIMEOUT = 40_000;

// ─── Seed once before all group tests ────────────────────────────────────────

test.beforeAll(async () => {
  const { access_token } = await getServiceAccountToken();
  await seedGroupForTest(access_token, SHEET_ID, TEST_GROUP, {
    budgetAmount: GROUP_BUDGET,
    templateAmount: GROUP_TEMPLATE,
    month: MONTH,
  });
});

/**
 * Navigate to Plan, inject auth, and wait for sync to complete.
 * Reused in beforeAll blocks — one sync per describe group, not one per test.
 */
async function loadPlanPage(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await injectServiceAccountAuth(page);
  await page.goto('./#/plan');
  await expect(page.getByTestId('budget-row').first()).toBeVisible({ timeout: SYNC_TIMEOUT });
  return page;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

test.describe('Plan screen — group budgeting sidebar (desktop)', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    sharedPage = await loadPlanPage(browser, { width: 1024, height: 768 });
  });

  test.afterAll(async () => {
    await sharedPage.context().close();
  });

  test('by_group group shows a G badge in the sidebar', async () => {
    const tab = sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP });
    await expect(tab).toBeVisible();
    await expect(tab.locator('.plan-group-tab-badge')).toHaveText('G');
  });

  test('by_category group does NOT show a G badge', async () => {
    const otherTabs = sharedPage.locator('.plan-group-tab').filter({
      hasNot: sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP }),
    });
    await expect(otherTabs.first()).toBeVisible();
    for (const tab of await otherTabs.all()) {
      await expect(tab.locator('.plan-group-tab-badge')).not.toBeAttached();
    }
  });

  test('sidebar shows groupAvailable (dollar amount) for by_group group', async () => {
    const tab = sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP });
    await expect(tab.locator('.plan-group-tab-total')).toHaveText(/\$[\d,]+/);
  });
});

// ─── Group Envelope row ───────────────────────────────────────────────────────

test.describe('Plan screen — Group Envelope row', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    sharedPage = await loadPlanPage(browser, { width: 1024, height: 768 });
    // Select Food & Dining in the sidebar so its detail is visible for all tests
    await sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();
  });

  test.afterAll(async () => {
    await sharedPage.context().close();
  });

  test('Group Envelope row appears at the top of a by_group group', async () => {
    const envelope = sharedPage.locator('.budget-row--group-envelope');
    await expect(envelope).toBeVisible();
    await expect(envelope).toContainText('Group Envelope');
  });

  test('Group Envelope row shows seeded assigned amount', async () => {
    await expect(sharedPage.locator('.budget-row--group-envelope')).toContainText('$1,500');
  });

  test('category rows inside by_group group have actuals-only style (no overspent class)', async () => {
    const categoryRows = sharedPage.locator('.budget-row--actuals-only');
    await expect(categoryRows.first()).toBeVisible();
    const count = await categoryRows.count();
    for (let i = 0; i < count; i++) {
      await expect(categoryRows.nth(i)).not.toHaveClass(/overspent/);
    }
  });

  test('category rows show only category name and activity columns (not assigned/available)', async () => {
    const firstRow = sharedPage.locator('.budget-row--actuals-only').first();
    await expect(firstRow).toBeVisible();
    const spans = firstRow.locator('.col-num');
    await expect(spans.nth(0)).toBeEmpty();
    await expect(spans.nth(2)).toBeEmpty();
  });

  test('clicking Group Envelope row opens the assignment sheet', async () => {
    await sharedPage.locator('.budget-row--group-envelope').click();
    const sheet = sharedPage.locator('.assign-sheet');
    await expect(sheet).toBeVisible({ timeout: 3_000 });
    await expect(sheet).toContainText(TEST_GROUP);
    await expect(sharedPage.locator('#assign-group-input')).toBeVisible();
    // Close via Cancel — the overlay has no Escape key handler, backdrop click is the dismiss path
    await sharedPage.getByRole('button', { name: /^Cancel$/i }).click();
    await expect(sheet).not.toBeAttached({ timeout: 3_000 });
  });

  test('saving a new group budget amount updates the display', async () => {
    await sharedPage.locator('.budget-row--group-envelope').click();
    await expect(sharedPage.locator('#assign-group-input')).toBeVisible({ timeout: 3_000 });

    await sharedPage.locator('#assign-group-input').fill('1800');
    await sharedPage.getByRole('button', { name: /^Save$/i }).click();

    await expect(sharedPage.locator('.assign-sheet')).not.toBeAttached({ timeout: 10_000 });
    await expect(sharedPage.locator('.budget-row--group-envelope')).toContainText('$1,800');
  });
});

// ─── Apply Template ───────────────────────────────────────────────────────────

test.describe('Plan screen — Apply Template with group budget', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    sharedPage = await loadPlanPage(browser, { width: 1024, height: 768 });
  });

  test.afterAll(async () => {
    await sharedPage.context().close();
  });

  test('Apply Template button is enabled when a by_group group has a template amount', async () => {
    const btn = sharedPage.getByRole('button', { name: /Apply Template/i });
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  });
});

// ─── Mobile layout ────────────────────────────────────────────────────────────

test.describe('Plan screen — group budgeting mobile layout', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    sharedPage = await loadPlanPage(browser, { width: 390, height: 844 });
  });

  test.afterAll(async () => {
    await sharedPage.context().close();
  });

  test('group header shows groupAvailable balance for by_group group', async () => {
    const groupHeader = sharedPage.locator('.group-header', { hasText: TEST_GROUP });
    await expect(groupHeader).toBeVisible({ timeout: 5_000 });
    await expect(groupHeader.locator('.group-total')).toHaveText(/\$[\d,]+/);
  });

  test('Group Envelope row is visible and tappable on mobile', async () => {
    const envelope = sharedPage.locator('.budget-row--group-envelope').first();
    await expect(envelope).toBeVisible({ timeout: 5_000 });
    await envelope.click();

    await expect(sharedPage.locator('.assign-sheet')).toBeVisible({ timeout: 3_000 });
    await expect(sharedPage.locator('#assign-group-input')).toBeVisible();
  });
});
