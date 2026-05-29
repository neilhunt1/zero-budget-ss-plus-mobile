import { test, expect } from '@playwright/test';
import { injectServiceAccountAuth } from './fixtures/auth';

// ─── Auth-free smoke (runs against any build, no sheet access needed) ─────────

test.describe('auth-free smoke', () => {
  test('app loads with correct title', async ({ page }) => {
    const messages: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') messages.push(msg.text());
    });

    await page.goto('./');
    await expect(page).toHaveTitle(/Zero Budget/);

    // Give the app a moment to finish initialising
    await page.waitForLoadState('networkidle');
    expect(messages.filter((m) => !m.includes('net::ERR_ABORTED'))).toHaveLength(0);
  });

  test('login screen is visible when unauthenticated', async ({ page }) => {
    await page.goto('./');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });
});

// ─── Authenticated smoke (proves auth injection + sheet data path) ────────────
// Assertions are intentionally loose (`.first()`, not exact counts) so these
// are stable against real changing prod data as well as seeded test data.

test.describe('authenticated smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Log ALL Sheets/Drive API responses so we can diagnose sync failures
    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('sheets.googleapis.com') || url.includes('googleapis.com/drive')) {
        const ok = res.ok();
        if (!ok) console.error(`API ${res.status()} ${res.request().method()} ${url}`);
        else console.log(`API ${res.status()} ${res.request().method()} ${url.split('?')[0]}`);
      }
    });
    await injectServiceAccountAuth(page);
  });

  test('plan screen loads with budget data', async ({ page }) => {
    await page.goto('./#/plan');
    await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('plan-screen')).toBeVisible({ timeout: 5_000 });
    // Fail fast if the sync error banner appears — no point waiting 15s for data
    await expect(page.getByText('Sync failed')).not.toBeVisible({ timeout: 3_000 });
    // At least one budget row proves the Sheets API call returned data
    await expect(page.getByTestId('budget-row').first()).toBeVisible({ timeout: 15_000 });
  });

  test('accounts screen loads with transactions', async ({ page }) => {
    await page.goto('./#/accounts');
    await expect(page.getByTestId('tx-list')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Sync failed')).not.toBeVisible({ timeout: 3_000 });
    // At least one transaction proves the Transactions tab loaded from the sheet
    await expect(page.getByTestId('tx-row').first()).toBeVisible({ timeout: 15_000 });
  });
});
