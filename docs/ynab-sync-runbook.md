# YNAB Sync Runbook

How to bring your Zero Budget sheets (dev, prod, test) up to speed with the latest from YNAB.

---

## What you need from YNAB

Two separate CSV exports:

| File | YNAB view | Save as |
|---|---|---|
| **Plan** (budget assignments) | Budget → Reports → Budget (monthly grid) → Export | `data/ynab/plan.csv` |
| **Register** (transactions) | All Accounts → Register → Export | `data/ynab/register.csv` |

Both files go in `data/ynab/` at the project root. They are gitignored — never commit them.

> **BOM note:** YNAB exports include a UTF-8 BOM. The scripts strip it automatically — no manual cleaning needed.

---

## The two-script model

| Script | What it does |
|---|---|
| `import:ynab:plan` | Syncs **budget assignments** — wipes/rewrites rows in the Budget tab for months ≤ cutover. |
| `import:ynab:register` | Imports **transactions** — deletes all rows ≤ cutover date, then imports YNAB rows. |

Run them in this order:

```bash
# Dev sheet
npm run import:ynab:plan:dev -- --cutover-date 2026-06-01
npm run import:ynab:register:dev -- --cutover-date 2026-06-01

# Prod sheet (post-merge only)
npm run import:ynab:plan:prod -- --cutover-date 2026-06-01
npm run import:ynab:register:prod -- --cutover-date 2026-06-01
```

Both scripts write `live_sync_from_date = 2026-06-02` to the `Config` tab automatically.

---

## The cutover date concept

`--cutover-date` declares the boundary between your legacy system (YNAB) and your live sync (BTS):

```
YNAB is authoritative: ←──────────────── cutover ─┐
BTS live:                                          └──────────────────→ now
```

**What each script does with `--cutover-date`:**

- **Plan import:** wipes ALL budget assignment rows (any source: manual, template, ynab_import) for months ≤ cutover month, replaces with YNAB data. Rows for months after cutover are untouched.
- **Register import:** deletes ALL transaction rows (any source) with `date ≤ cutover-date`, then imports YNAB transactions up to that date. Transactions after the cutover date are untouched.

This means you can re-import from YNAB as many times as you like while you're still working in YNAB — each run replaces the pre-cutover window cleanly. There is no overlap, no duplicate queue, and no manual review needed.

### What happens after actual cutover

Once you stop using YNAB and BTS becomes your sole source of truth, simply stop passing `--cutover-date`. From that point you won't need the register import at all; BTS feeds transactions automatically.

---

## Typical dev workflow

```bash
# 1. Export plan.csv and register.csv from YNAB, drop in data/ynab/

# 2. Sync dev sheet (set cutover-date to the last date your YNAB export covers)
npm run import:ynab:plan:dev -- --cutover-date 2026-06-01
npm run import:ynab:register:dev -- --cutover-date 2026-06-01

# 3. Run integration tests against dev
npm run test:integration
```

No pre-cleaning of CSV data is required. The scripts handle BOM stripping, emoji normalization, split transaction grouping, and dedup automatically.

---

## Test sheet (seed-test-sheet)

The test sheet is provisioned by `scripts/seed-test-sheet.ts` and is reset before each integration test run — it uses synthetic fixture data, not real YNAB exports. You do not need to run the YNAB import scripts against the test sheet.

---

## After a YNAB sync: what changed

After running both scripts:

| Tab | What changed |
|---|---|
| Budget | All `source:ynab_import` assignment rows replaced with latest plan |
| Transactions | New YNAB transactions appended; `source:ynab_import` tag |
| Dashboard!B2 | `LastYnabSync` timestamp updated |
| Transactions (seed) | Opening balance rows regenerated from BTS Balance History |

`source:manual` and `source:template` rows are **never touched** by either script.

---

## File locations summary

```
data/
  ynab/
    plan.csv         ← YNAB Budget export (gitignored)
    register.csv     ← YNAB Register export (gitignored)
```

Pass a custom path at any time:
```bash
npm run import:ynab:plan:dev -- --file ~/Downloads/my-plan.csv
npm run import:ynab:register:dev -- --file ~/Downloads/my-register.csv --cutover-date 2026-06-01
```
