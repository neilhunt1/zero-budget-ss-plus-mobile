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
 *
 * Project coverage:
 *   desktop-chrome / desktop-webkit : all describe blocks except "mobile layout"
 *   mobile-chrome / mobile-safari   : "Group Envelope row", "Apply Budget Plan",
 *                                     "mobile layout" (sidebar skipped — not rendered)
 */

import { test, expect, Page, Browser, WorkerInfo } from '@playwright/test';
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
 * Navigate to Plan using the project's device settings (viewport, user-agent, etc.)
 * and wait for the full sync to complete.
 *
 * Passing workerInfo lets each Playwright project (desktop-chrome, mobile-chrome, etc.)
 * bring its own viewport and device emulation — previously hardcoded viewports meant
 * mobile-chrome was actually running at desktop size.
 */
async function loadPlanPage(browser: Browser, workerInfo: WorkerInfo): Promise<Page> {
  // Use the project's full device settings so mobile projects get the correct viewport,
  // user-agent, touch events, etc.
  const context = await browser.newContext(workerInfo.project.use);
  const page = await context.newPage();
  await injectServiceAccountAuth(page);
  await page.goto('./#/plan');
  await expect(page.getByTestId('budget-row').first()).toBeVisible({ timeout: SYNC_TIMEOUT });
  return page;
}

function isMobile(workerInfo: WorkerInfo): boolean {
  return workerInfo.project.name.includes('mobile');
}

// ─── Sidebar (desktop only) ───────────────────────────────────────────────────
// The sidebar only renders on viewport ≥ 768px. Skipped on mobile projects.

test.describe('Plan screen — group budgeting sidebar', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }, workerInfo) => {
    if (isMobile(workerInfo)) return; // page not created — all tests will skip
    sharedPage = await loadPlanPage(browser, workerInfo);
  });

  test.afterAll(async () => {
    await sharedPage?.context().close();
  });

  test('by_group group shows a G badge in the sidebar', async ({}, workerInfo) => {
    test.skip(isMobile(workerInfo), 'Sidebar not rendered on mobile viewport');
    const tab = sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP });
    await expect(tab).toBeVisible();
    await expect(tab.locator('.plan-group-tab-badge')).toHaveText('G');
  });

  test('by_category group does NOT show a G badge', async ({}, workerInfo) => {
    test.skip(isMobile(workerInfo), 'Sidebar not rendered on mobile viewport');
    const otherTabs = sharedPage.locator('.plan-group-tab').filter({ hasNotText: TEST_GROUP });
    await expect(otherTabs.first()).toBeVisible();
    for (const tab of await otherTabs.all()) {
      await expect(tab.locator('.plan-group-tab-badge')).not.toBeAttached();
    }
  });

  test('sidebar shows groupAvailable (dollar amount) for by_group group', async ({}, workerInfo) => {
    test.skip(isMobile(workerInfo), 'Sidebar not rendered on mobile viewport');
    const tab = sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP });
    await expect(tab.locator('.plan-group-tab-total')).toHaveText(/\$[\d,]+/);
  });
});

// ─── Group Envelope row (desktop + mobile) ────────────────────────────────────
// Runs on all projects. On desktop, navigates to Food & Dining via sidebar.
// On mobile, all groups are stacked so no sidebar navigation is needed.

test.describe('Plan screen — Group Envelope row', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }, workerInfo) => {
    sharedPage = await loadPlanPage(browser, workerInfo);
    // On desktop, select Food & Dining in the sidebar to show its detail panel
    if (!isMobile(workerInfo)) {
      await sharedPage.locator('.plan-group-tab', { hasText: TEST_GROUP }).click();
    }
  });

  test.afterAll(async () => {
    await sharedPage?.context().close();
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
    // Close via Cancel — the overlay has no Escape key handler
    await sharedPage.getByRole('button', { name: /^Cancel$/i }).click();
    await expect(sheet).not.toBeAttached({ timeout: 3_000 });
  });

  test('saving a new group budget amount updates the display', async ({}, workerInfo) => {
    // Only run the write test on desktop to avoid double-writing (one project is enough)
    test.skip(isMobile(workerInfo), 'Write tested on desktop; skipped on mobile to avoid double-write');
    await sharedPage.locator('.budget-row--group-envelope').click();
    await expect(sharedPage.locator('#assign-group-input')).toBeVisible({ timeout: 3_000 });

    await sharedPage.locator('#assign-group-input').fill('1800');
    await sharedPage.getByRole('button', { name: /^Save$/i }).click();

    await expect(sharedPage.locator('.assign-sheet')).not.toBeAttached({ timeout: 10_000 });
    await expect(sharedPage.locator('.budget-row--group-envelope')).toContainText('$1,800');
  });
});

// ─── Apply Budget Plan (desktop + mobile) ───────────────────────────────────────

test.describe('Plan screen — Apply Budget Plan with group budget', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }, workerInfo) => {
    sharedPage = await loadPlanPage(browser, workerInfo);
  });

  test.afterAll(async () => {
    await sharedPage?.context().close();
  });

  test('Apply Budget Plan button is enabled when a by_group group has a template amount', async () => {
    const btn = sharedPage.getByRole('button', { name: /Apply Budget Plan/i });
    await expect(btn).toBeEnabled({ timeout: 5_000 });
  });
});

// ─── Mobile-specific layout (mobile projects only) ────────────────────────────
// Verifies mobile-specific rendering: stacked group headers, touch interactions.
// Skipped on desktop projects where a sidebar is shown instead.

test.describe('Plan screen — group budgeting mobile layout', () => {
  test.describe.configure({ mode: 'serial' });

  let sharedPage: Page;

  test.beforeAll(async ({ browser }, workerInfo) => {
    if (!isMobile(workerInfo)) return;
    sharedPage = await loadPlanPage(browser, workerInfo);
  });

  test.afterAll(async () => {
    await sharedPage?.context().close();
  });

  test('group header shows groupAvailable balance for by_group group', async ({}, workerInfo) => {
    test.skip(!isMobile(workerInfo), 'Mobile stacked layout only');
    const groupHeader = sharedPage.locator('.group-header', { hasText: TEST_GROUP });
    await expect(groupHeader).toBeVisible({ timeout: 5_000 });
    await expect(groupHeader.locator('.group-total')).toHaveText(/\$[\d,]+/);
  });

  test('Group Envelope row is visible and tappable on mobile', async ({}, workerInfo) => {
    test.skip(!isMobile(workerInfo), 'Mobile stacked layout only');
    const envelope = sharedPage.locator('.budget-row--group-envelope').first();
    await expect(envelope).toBeVisible({ timeout: 5_000 });
    await envelope.click();

    await expect(sharedPage.locator('.assign-sheet')).toBeVisible({ timeout: 3_000 });
    await expect(sharedPage.locator('#assign-group-input')).toBeVisible();
  });
});
