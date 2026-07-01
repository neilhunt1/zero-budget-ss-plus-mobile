# BankToSheets Zero Budget (BTSZB) — Agent Guide

## System Overview
BTSZB is a mobile-first personal budgeting Progressive Web App (PWA) designed to replace YNAB. It uses Google Sheets as a backend database with an offline-first architecture.

## Tech Stack
- **Frontend:** React + TypeScript + Vite (Deployed to GitHub Pages)
- **Local Mirror:** Dexie / IndexedDB for local caching (Instant read/search)
- **Data Synchronization:** Optimistic writes (Write locally to IndexedDB first, push to Google Sheets in background, roll back on failure)
- **Backend:** Google Sheets API (OAuth for user app, Service Account for automated scripts)
- **Automation:** Google Apps Script for sheet-side processing
- **Testing:** Vitest (400+ unit tests), Playwright (E2E testing)

## Core Database Conventions
- **The Google Sheet is the absolute source of truth.** IndexedDB acts as a high-speed local mirror.
- **Available balances** are derived via formulas using month-to-month rollover logic. They are calculated dynamically at runtime and never stored statically.
- `category_group` and `subgroup` dimensions are **not** stored directly on transactions. They are derived from the `Budget` tab mappings at read time.
- **Transaction Types:** `regular`, `income`, and `transfer`. Credit card payments are handled as standard transfers.

## Key Project Scripts
- `npm run test` — Runs the full Vitest unit testing suite.
- `npm run setup:dev` / `setup:prod` — Provisions core sheet schemas.
- `npm run sync-from-prod-to-dev` — Clones production data matrices down to the dev testing environment.

## Execution Constraints
1. **Never break the Vitest coverage.** Always run `npm run test` before completing a task. If changes alter core states, update or add matching tests.
2. **Maintain Type Safety.** Strict TypeScript compilation is required. Do not introduce loose types (`any`).
3. **Optimistic Write Consistency.** Ensure any modifications to transaction states or budget rows safely update Dexie *before* attempting the Google Sheets replication layer.
