# Zero Budget

A mobile-first zero-based budgeting app. Google Sheets is the backend; React is the frontend. Both are first-class citizens.

## Quick Start

```bash
npm install
cp .env.example .env.development   # fill in GOOGLE_SHEET_ID, VITE_GOOGLE_CLIENT_ID etc.
npm run dev                         # http://localhost:5173
```

## Testing

### Run tests locally

```bash
npm test              # single run (same as CI)
npm run test:watch    # watch mode — re-runs on file save
npm run test:coverage # run with coverage → test-results/coverage/index.html
```

### Where to put tests

```
tests/
  unit/         ← pure function tests, no network, no Google account required
  integration/  ← Sheets API tests against the permanent test sheet (future)
```

### Mocking pattern for the Sheets API

Unit tests never hit the real Sheets API. Functions that accept a `SheetsClient` can be tested with a minimal mock:

```typescript
import { vi } from 'vitest';
import type { SheetsClient } from '../../src/api/client';

const mockClient = {
  getValues: vi.fn().mockResolvedValue({ values: [/* rows */] }),
  updateValues: vi.fn().mockResolvedValue(undefined),
  appendValues: vi.fn().mockResolvedValue(undefined),
} as unknown as SheetsClient;
```

Pure view-builder functions (`buildGroupedBudget`, `computeCategoryActivity`) take plain arrays/Maps — no mocking needed. See `tests/unit/budget.test.ts` for the pattern.

### CI

Tests run on every push and PR via `.github/workflows/test.yml`.  
Results appear in the GitHub Actions **Checks** tab via [dorny/test-reporter](https://github.com/dorny/test-reporter).  
Coverage is uploaded as a workflow artifact (14-day retention).

## Sheet provisioning

```bash
npm run setup:dev    # provisions dev sheet from categories.json
npm run setup:prod   # provisions prod sheet
```

See [CLAUDE.md](CLAUDE.md) for full architecture, sheet rules, and backlog.
