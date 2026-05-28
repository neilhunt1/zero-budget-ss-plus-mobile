import { test, expect } from '@playwright/test';
import { injectServiceAccountAuth } from './fixtures/auth';

// ─── Auth-free smoke (runs against any build, no sheet access needed) ─────────

test.describe('auth-free smoke', () => {
  test('app loads with correct title', async ({ page }) => {
    const messages: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') messages.push(msg.text());
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/Zero Budget/);

    // Give the app a moment to finish initialising
    await page.waitForLoadState('networkidle');
    expect(messages.filter((m) => !m.includes('net::ERR_ABORTED'))).toHaveLength(0);
  });

  test('login screen is visible when unauthenticated', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });
});

// ─── Authenticated smoke (proves auth injection + sheet data path) ────────────

test.describe('authenticated smoke', () => {
  test.beforeEach(async ({ page }) => {
    await injectServiceAccountAuth(page);
  });

  test('Plan screen is visible after auth injection', async ({ page }) => {
    await page.goto('/#/plan');
    await page.waitForLoadState('networkidle');

    // The Plan screen renders a header and category list — wait for the nav to appear
    await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('plan-screen')).toBeVisible({ timeout: 15_000 });
  });
});
