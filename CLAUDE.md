# Zero Budget — Claude Code Context

A mobile-first zero-based budgeting app. Google Sheets is the backend; React is the frontend. Both are first-class citizens.

## Tech Stack

- **Backend storage**: Google Sheets (API-managed)
- **Sheet provisioning**: `scripts/setup-sheet.ts` (TypeScript, ts-node)
- **Categories config**: `config/categories.json` (validated against `config/categories.schema.json`)
- **Frontend**: React PWA (not yet built)
- **Auth**: Google OAuth (app) + service account (scripts)

## Sheet Rules — Read Before Touching the Sheet

- **Never manually restructure the sheet.** All structural changes go in `scripts/setup-sheet.ts`.
- The app reads columns by **header name**, not position. Safe as long as headers don't change.
- Always **append new columns to the right** in code — never insert in the middle.
- Re-running `setup-sheet.ts` is always safe — it checks before overwriting.
- Dev sheet and prod sheet are separate Google Sheets, distinguished by `GOOGLE_SHEET_ID` in `.env.development` vs `.env.production`.

## Categories

- `config/categories.json` is the **single source of truth** for categories.
- Adding or renaming a category = edit `categories.json` + re-run `setup-sheet.ts`.
- Schema is validated at runtime against `config/categories.schema.json` (JSON Schema draft-07).
- A group has either `subgroups` or `categories` directly — never both.

## Running the Setup Script

```bash
npm run setup:dev   # provisions dev sheet
npm run setup:prod  # provisions prod sheet
```

Prerequisites (one-time):
1. Google Cloud project with Sheets API enabled
2. Service account with Editor access to the sheet
3. Service account JSON key at path in `.env.development` / `.env.production`

## Sheet Tabs

| Tab | Purpose |
|-----|---------|
| `Transactions` | All transactions — source of truth |
| `Budget` | Categories + monthly assigned amounts |
| `Templates` | Recurring split templates |
| `Reflect` | Charts and summary pivots |
| `BankToSheets_Raw` | Written by BankToSheets integration — do not edit |
| `YNAB_Import` | One-time historical import — hidden |

## Key Design Decisions

- **Available balance is never stored** — always calculated as assigned + inflows − outflows.
- **Split transactions** use parent + child rows in the same Transactions tab (`parent_id` links them).
- **Transfers** are linked pairs sharing a `transfer_pair_id` — no budget impact.
- **Category types**: `fluid` (moveable spending), `fixed_bill` (non-negotiable), `savings_target` (committed).
