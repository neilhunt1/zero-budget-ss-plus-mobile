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

Dev sheet can be refreshed from prod manually via `sync-from-prod-to-dev` (not part of CI).

---

## CI/CD Pipeline

### PR workflow (pr.yml)
1. `npm test` — unit tests, must pass
2. `npm run setup:dev` — provision dev sheet schema (validate migrations run cleanly; no data sync)
3. `npm run setup:test && npm run seed:test` — reset test sheet to known state
4. `npm run test:integration` — integration tests against test sheet
5. E2E tests against test sheet

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

**User-facing** (visible in tab bar, human-editable or human-readable):
| Tab | Purpose | Editable by scripts |
|---|---|---|
| Transactions | All transactions, single source of truth | Yes |
| Budget | Monthly assignments only (row 1 = headers, rows 2+ = data) | Yes |
| Categories | Category definitions — **user-owned data, edit directly in sheet** | Seed only (first run) |
| Groups | Group budget settings (budget_type, rollover, etc.) | Append-only |
| Split Rules | Auto-split transaction rules (match payee → split into categories) | Yes |
| Reflect | Charts and summaries | Read only |

**Process-managed** (hidden from tab bar, never manually edited):
| Tab | Purpose | Editable by scripts |
|---|---|---|
| Meta | App state + script config (replaces Dashboard + Config) | Yes |
| Budget_Log | Audit trail of budget changes | Yes |
| Budget_Calcs | Per-category per-month activity/assigned/available formulas | Yes (rewritten on setup) |
| Transactions (BTS) | BankToSheets raw source data | No — BTS owned |
| Balance History (BTS) | BankToSheets account balance history | No — BTS owned |

### Tab layouts
**Budget tab** (assignments only):
```
Row 1:   Headers — month | category | assigned | source | category_group
Rows 2+: Assignment data (grows indefinitely)
```

**Categories tab** (user-owned):
```
Row 1:   Headers — category_group | category_subgroup | category | category_type | monthly_template_amount | sort_order | active
Rows 2+: Category data (editable directly in the sheet)
```
setup-sheet.ts seeds this from `categories.json` only when the tab is empty. After that, the user owns it.

**Meta tab** (process-managed, hidden):
```
Row 1:   key                    | value   ← headers
Row 2:   ReadyToAssign          | <live formula>
Row 3:   LastYnabSync           | <timestamp written by import scripts>
Row 4:   TotalAssignedThisMonth | <live formula>
Row 5:   TotalAvailable         | <live formula>
Rows 6+: script config key-value pairs (e.g. live_sync_from_date)
```

Constants `ASSIGNMENTS_START_ROW`, `CATEGORIES_START_ROW` etc. are defined in `src/api/budget.ts`. Always use these constants — never hardcode row numbers.

### Named ranges
- `ReadyToAssign` → Meta!B2 (live formula)
- `LastYnabSync` → Meta!B3 (written by import scripts)
- `TotalAssignedThisMonth` → Meta!B4
- `TotalAvailable` → Meta!B5

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
- `template` — applied by Apply Budget Plan feature
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
| `npm run import:ynab:plan:dev` | Sync YNAB Plan CSV (budget assignments) to dev sheet |
| `npm run import:ynab:plan:prod` | Sync YNAB Plan CSV (budget assignments) to prod sheet |
| `npm run import:ynab:register:dev` | Import YNAB transaction register to dev sheet |
| `npm run import:ynab:register:prod` | Import YNAB transaction register to prod sheet |
| `npm run sync-from-prod-to-dev` | Clone prod data to dev for PR testing |
| `npm test` | Run all unit tests |
| `npm run test:integration` | Run integration tests against dev sheet |

See **[docs/ynab-sync-runbook.md](docs/ynab-sync-runbook.md)** for the full YNAB sync workflow including BTS/YNAB deduplication strategy.

---

## Data import language

When discussing or implementing data import features, refer to the import process generically (e.g. "the import script", "legacy data import", "external data source") rather than naming YNAB specifically. The exception is code or config that is genuinely YNAB-specific to the data model (e.g. a script named `import-ynab-register.ts` may keep that name). In docs, comments, issue descriptions, and UI copy, keep the language source-agnostic — we may support other import sources in the future and don't want to couple user-facing language to one provider.

---

## User Guide

`docs/USER_GUIDE.md` is the end-user guide for Zero Budget. When implementing a new user-facing feature, add (or update) the relevant section before closing the PR. If the feature is not yet fully built, add a placeholder section with a note and a list of topics to cover when it is.

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