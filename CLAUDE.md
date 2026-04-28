# CLAUDE.md — Zero Budget (BTSZB)

This file gives Claude Code persistent context about this project. Read it at the start of every session.

---

## What this project is

A mobile-first personal budgeting web app replacing YNAB, built by Neil Hunt.
- **Frontend:** React PWA, deployed on GitHub Pages
- **Backend:** Google Sheets (API-managed, treated as infrastructure not a manual artifact)
- **Bank sync:** BankToSheets (Plaid-backed), writes to BankToSheets_Raw tab
- **Scripts:** Node.js/TypeScript in `scripts/` for sheet provisioning and data migration
- **Testing:** Vitest for unit tests, integration tests run against dev Google Sheet

The repo is `neilhunt1/zero-budget-ss-plus-mobile`.

---

## Two-Claude pattern

- **Claude Chat** (claude.ai): handles design, architecture, requirements, backlog grooming
- **Claude Code** (you): handles implementation, file editing, running scripts, pushing commits
- The requirements doc lives at: `docs/requirements.md` (or the shared brain artifact)
- When you make significant architectural decisions, note them so Claude Chat can update the doc

---

## Environments

| Env | Sheet name | Config file | npm scripts |
|---|---|---|---|
| Dev | BTSZB-Dev | .env.development | setup:dev, sync-from-ynab:dev |
| Prod | BTSZB-Prod | .env.production | setup:prod, sync-from-ynab:prod |

**Critical:** Never run setup:prod or any prod script during a PR workflow. Prod is only touched post-merge or by explicit manual run.

Dev sheet is always refreshed from prod before PR testing via `sync-from-prod-to-dev`.

---

## CI/CD Pipeline

### PR workflow (pr.yml)
1. `npm test` — unit tests, must pass
2. `npm run setup:dev` — provision dev sheet to latest schema
3. `npm run sync-from-prod-to-dev` — clone prod data to dev
4. `npm run test:integration` — integration tests against dev sheet

### Merge workflow (main.yml)
1. `npm test` — unit tests, must pass
2. `npm run setup:prod` — provision prod sheet
3. Deploy frontend to GitHub Pages

### Auth in CI
Service account key is in `GOOGLE_SERVICE_ACCOUNT_KEY` secret (base64 encoded).
```bash
echo '${{ secrets.GOOGLE_SERVICE_ACCOUNT_KEY }}' | base64 -d > /tmp/sa-key.json
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa-key.json
```

---

## Google Sheet structure

### Tabs
| Tab | Purpose | Editable by scripts |
|---|---|---|
| Transactions | All transactions, single source of truth | Yes |
| Budget | Dashboard header (rows 1-5) + categories (rows 6-506) + assignments (rows 508+) | Yes |
| Templates | Recurring split templates | Yes |
| Reflect | Charts and summaries | Read only |
| BankToSheets_Raw | BankToSheets writes here | No — BTS owned |
| YNAB_Plan_Import | YNAB Plan CSV pasted here by user | Read only by scripts |
| YNAB_Transactions_Import | Reserved for M4 YNAB transaction import | Read only by scripts |

### Budget tab layout (IMPORTANT — row offsets matter)
```
Rows 1-5:   Dashboard header (ReadyToAssign, LastYnabSync, TotalAssignedThisMonth, TotalAvailable)
Row 6:      Category table headers
Rows 7-506: Category data (500 row buffer — plenty of headroom)
Row 507:    Visual separator
Row 508:    Assignment table headers (month, category, assigned, source)
Row 509+:   Assignment data (grows indefinitely)
```
Constants `ASSIGNMENTS_START_ROW`, `CATEGORY_START_ROW` etc. are defined in `src/api/budget.ts`. Always use these constants — never hardcode row numbers.

### Named ranges
- `ReadyToAssign` → Budget!B1 (live formula)
- `LastYnabSync` → Budget!B2 (written by sync-from-ynab)
- `TotalAssignedThisMonth` → Budget!B3
- `TotalAvailable` → Budget!B4

### Column rules
- **Always append new columns to the right** — never insert in the middle
- Columns are referenced by header name, not position
- Row offsets are defined as constants — always use the constants

---

## Schema conventions

### Transaction source values
- `banksheets` — imported from BankToSheets_Raw by Apps Script
- `manual` — entered by user in app
- `seed` — opening balance created by sync-from-ynab script (wiped on re-run)
- `ynab_import` — imported from YNAB transaction CSV (M4)

### Budget assignment source values
- `ynab_import` — written by sync-from-ynab script (wiped on re-run)
- `manual` — assigned by user via app
- `template` — applied by Apply Template feature
- **Only `ynab_import` rows are ever wiped by scripts — never touch manual or template rows**

### Category name conventions
- Canonical names live in `config/categories.json`
- Emojis are part of the canonical name (e.g. "Groceries 🛒")
- When matching YNAB export data, strip non-ASCII before comparing, use canonical name in output
- Category matching is always by name only — never by group (groups were reorganized from YNAB)

---

## Testing conventions

```
tests/
├── unit/
│   ├── business-logic/    # balance calculations, matching logic
│   └── setup-sheet/       # category safety, schema checks
└── integration/           # against dev Google Sheet, tagged @integration
```

- Unit tests: `npm test` — no external dependencies, fast, run everywhere
- Integration tests: `npm run test:integration` — require `GOOGLE_APPLICATION_CREDENTIALS`, run against dev sheet only
- Every new script or feature should include unit tests
- Integration tests for anything that touches the sheet schema or does data migration
- Mock pattern for Google Sheets API: see `tests/unit/budget-fetch.test.ts` as reference

### Running tests locally
```bash
npm test                    # unit tests only
npm run test:watch          # watch mode
npm run test:coverage       # with coverage report
npm run test:integration    # integration tests (requires .env.development + service account)
```

---

## Safe category removal
When `setup-sheet.ts` runs and a category in the sheet no longer exists in `categories.json`:
- **Has transactions** → set `active: false`, log warning with transaction count. Never delete.
- **No transactions** → remove cleanly, log info.

Never delete a category row that has transaction history. Use `active: false` instead.

---

## Key scripts

| Script | Purpose |
|---|---|
| `npm run setup:dev` | Provision dev sheet to latest schema |
| `npm run setup:prod` | Provision prod sheet to latest schema |
| `npm run sync-from-ynab:dev` | Sync YNAB Plan CSV to dev sheet |
| `npm run sync-from-ynab:prod` | Sync YNAB Plan CSV to prod sheet |
| `npm run sync-from-prod-to-dev` | Clone prod data to dev for PR testing |
| `npm test` | Run all unit tests |
| `npm run test:integration` | Run integration tests against dev sheet |

---

## What NOT to do
- Never manually edit the Google Sheet structure — always use setup-sheet.ts
- Never insert columns in the middle — always append right
- Never hardcode row numbers — use the constants in budget.ts
- Never run prod scripts in PR/branch workflows
- Never wipe `source: manual` or `source: template` rows in any script
- Never commit .env files — they are gitignored
- Never commit service account key JSON — use GitHub Actions secrets

---

## Current milestone
**M2: I Can See My Budget**
Active issues: #38, #39, #40 (infra prereqs), #36 (sync-from-ynab), #5, #4, #6, #8, #7 (Plan screen features)
Complete #38 → #39 → #40 → #36 in order before starting Plan screen features.

See full backlog and requirements at: [requirements doc in this conversation or docs/requirements.md]