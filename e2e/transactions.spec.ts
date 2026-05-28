import { test, expect } from '@playwright/test';
import { injectServiceAccountAuth } from './fixtures/auth';

// All tests in this file run authenticated against the seeded test sheet.
// Seed data is reset by `npm run seed:test` before each CI run.
// Seed transactions used here: see scripts/seed-test-sheet.ts

test.beforeEach(async ({ page }) => {
  await injectServiceAccountAuth(page);
});

test.describe('Transactions screen', () => {
  test('loads and shows seeded transactions', async ({ page }) => {
    await page.goto('/#/accounts');

    // Wait for the initial sheet sync — transactions come from Google Sheets on first load
    const txList = page.getByTestId('tx-list');
    await expect(txList).toBeVisible({ timeout: 30_000 });

    // Seed has 8 transactions — all should be visible
    const rows = txList.getByTestId('tx-row');
    await expect(rows).toHaveCount(8, { timeout: 30_000 });
  });

  test('shows correct payee and amount for known seed transactions', async ({ page }) => {
    await page.goto('/#/accounts');
    const txList = page.getByTestId('tx-list');

    // Wait for sync
    await expect(txList.getByTestId('tx-row').first()).toBeVisible({ timeout: 30_000 });

    // Amazon — $45.67 outflow, seed-001
    await expect(txList.getByText('Amazon')).toBeVisible();
    // Desktop list shows raw amount without sign; mobile card uses -/+ prefix.
    // Assert on the number itself which appears in both layouts.
    await expect(txList.getByText(/\$45\.67/)).toBeVisible();

    // Whole Foods — $89.12 outflow, seed-005
    await expect(txList.getByText('Whole Foods')).toBeVisible();
    await expect(txList.getByText(/\$89\.12/)).toBeVisible();

    // Employer income — $2,500 inflow, seed-002
    await expect(txList.getByText('Employer')).toBeVisible();
    await expect(txList.getByText(/\$2,500\.00/)).toBeVisible();
  });

  test('opens transaction detail on row click', async ({ page }) => {
    await page.goto('/#/accounts');
    const txList = page.getByTestId('tx-list');
    await expect(txList.getByTestId('tx-row').first()).toBeVisible({ timeout: 30_000 });

    // Click the Amazon row using its stable transaction ID
    const amazonRow = page.locator('[data-testid="tx-row"][data-transaction-id="seed-001"]');
    await expect(amazonRow).toBeVisible();
    await amazonRow.click();

    // On desktop the detail expands inline (tx-edit-inline); on mobile it's a
    // floating overlay (assign-sheet). Both get data-testid="tx-detail".
    const detail = page.getByTestId('tx-detail');
    await expect(detail).toBeAttached({ timeout: 10_000 });

    // Verify the detail form has the correct values.
    // Payee is the first text input; outflow is the first number input.
    await expect(detail.locator('input').first()).toHaveValue('Amazon');
    await expect(detail.locator('input[type="number"]').first()).toHaveValue('45.67');
  });

  test('filter chips narrow the transaction list', async ({ page }) => {
    await page.goto('/#/accounts');
    const txList = page.getByTestId('tx-list');
    await expect(txList.getByTestId('tx-row').first()).toBeVisible({ timeout: 30_000 });

    // Seed has 2 pending transactions (seed-001 Amazon, seed-006 Netflix)
    await page.getByRole('button', { name: 'Pending' }).click();
    await expect(txList.getByTestId('tx-row')).toHaveCount(2);
    await expect(txList.getByText('Amazon')).toBeVisible();
    await expect(txList.getByText('Netflix')).toBeVisible();
  });
});
