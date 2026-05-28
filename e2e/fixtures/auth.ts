import { Page } from '@playwright/test';
import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

/**
 * Load service account credentials from env.
 * Precedence (mirrors setup-sheet.ts):
 *   1. E2E_SERVICE_ACCOUNT_TOKEN — inline JSON (used in CI)
 *   2. GOOGLE_SERVICE_ACCOUNT_KEY — inline JSON (fallback)
 *   3. E2E_SERVICE_ACCOUNT_KEY_PATH — path to JSON file
 *   4. GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to JSON file (already in .env.test)
 */
function loadCredentials(): object {
  // Use || not ?? so empty-string env vars (GitHub's default for missing secrets) fall through
  const inlineKey =
    process.env.E2E_SERVICE_ACCOUNT_TOKEN || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (inlineKey) {
    return JSON.parse(inlineKey);
  }

  const keyPath =
    process.env.E2E_SERVICE_ACCOUNT_KEY_PATH ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    const resolved = path.resolve(process.cwd(), keyPath);
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  }

  throw new Error(
    'E2E auth: set E2E_SERVICE_ACCOUNT_TOKEN (JSON) or GOOGLE_SERVICE_ACCOUNT_KEY_PATH (file path) in .env.test'
  );
}

/** Exchange the service account JSON key for a short-lived Bearer token. */
export async function getServiceAccountToken(): Promise<{ access_token: string; expiry: number }> {
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [SHEETS_SCOPE, DRIVE_SCOPE],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();

  if (!tokenResponse.token) {
    throw new Error('Failed to obtain access token from service account');
  }

  // google-auth-library sets expiry_date on the credentials after the exchange
  const expiry = (client as any).credentials?.expiry_date ?? Date.now() + 55 * 60 * 1000;

  return { access_token: tokenResponse.token, expiry };
}

/**
 * Inject a service account token into localStorage before the page scripts run.
 * This bypasses the Google OAuth popup — the app reads localStorage on mount
 * via getStoredToken() in useAuth.tsx and considers the user authenticated.
 */
export async function injectServiceAccountAuth(page: Page): Promise<void> {
  const { access_token, expiry } = await getServiceAccountToken();

  await page.addInitScript(
    ({ token, exp }) => {
      localStorage.setItem('zb_access_token', token);
      localStorage.setItem('zb_token_expiry', String(exp));
    },
    { token: access_token, exp: expiry }
  );
}
