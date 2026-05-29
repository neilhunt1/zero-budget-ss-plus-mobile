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

// ─── Authenticated smoke (proves auth injection + connectivity) ───────────────
// These tests verify deployment and auth — NOT data loading.
// Data loading tests (exact row counts, specific payees) live in
// transactions.spec.ts and run against the seeded BTSZB-Test sheet in the
// PR workflow. Running them here against 28k+ prod transactions on every
// cold-start would take 60+ seconds and is fragile to prod data changes.

test.describe('authenticated smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Log failed API calls to diagnose connectivity issues
    page.on('response', (res) => {
      const url = res.url();
      if (
        (url.includes('sheets.googleapis.com') || url.includes('googleapis.com/drive')) &&
        !res.ok()
      ) {
        console.error(`API ${res.status()} ${res.request().method()} ${url}`);
      }
    });
    await injectServiceAccountAuth(page);
  });

  test('plan screen renders and sync starts without error', async ({ page }) => {
    await page.goto('./#/plan');
    // Nav and screen container appear quickly — proves auth injection worked and
    // the app accepted the token (would show login page if auth failed)
    await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('plan-screen')).toBeVisible({ timeout: 5_000 });
    // Sync should be running (not errored). Wait long enough for any immediate
    // API failures to surface before declaring success.
    await page.waitForTimeout(3_000);
    await expect(page.getByText('Sync failed')).not.toBeAttached();
  });

  test('accounts screen renders and sync starts without error', async ({ page }) => {
    await page.goto('./#/accounts');
    await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('accounts-screen')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(3_000);
    await expect(page.getByText('Sync failed')).not.toBeAttached();
  });
});
