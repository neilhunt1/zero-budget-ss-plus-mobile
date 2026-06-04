import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import * as path from 'path';

// Load .env.test so auth fixtures and sheet IDs are available locally.
// In CI these vars come from GitHub Actions secrets instead.
config({ path: path.resolve(__dirname, '.env.test'), override: false });

// Don't spin up a local preview server when pointing at an external URL
// (e.g. the prod smoke test in main.yml hits the live GHP deployment directly).
// Normalize to trailing slash so relative goto calls ('./#/route') resolve correctly —
// without it, './' resolves to the parent directory instead of the app root.
const baseURL = (process.env.BASE_URL ?? 'http://localhost:4173').replace(/\/?$/, '/');
const needsLocalServer = baseURL.includes('localhost');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // Never retry — flaky tests should fail visibly, not be silently hidden as "Flaky"
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],

  use: {
    baseURL,
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: process.env.CI
    ? [
        { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
      ]
    : [
        { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
        { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
        { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
      ],

  webServer: needsLocalServer
    ? {
        command: 'npm run preview',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      }
    : undefined,
});
