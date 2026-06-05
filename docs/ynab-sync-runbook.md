# Legacy Import Runbook

How to bring your Zero Budget sheets (dev, prod, test) up to speed with data from your legacy budgeting system while BankToSheets continues flowing in live transactions.

This runbook uses YNAB as the reference example, but the cutover pattern applies to any import source.

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

## The cutover date concept

`--cutover-date` declares the boundary between your legacy system and your live sync (BTS):

```
Legacy system authoritative: ←──────────────── cutover ─┐
BTS live sync authoritative:                             └──────────────→ now
```

Pass it as `YYYY-MM-DD` — typically the last date your legacy export covers (e.g. end of last month).

You can move the cutover date forward on each import as you continue working in your legacy system. Once you fully cut over to BTSZB, stop passing the flag; BTS feeds transactions automatically from that point.

---

## The two-script model

| Script | What it does |
|---|---|
| `import:ynab:plan` | Syncs **budget assignments** — wipes all rows for months ≤ cutover, replaces with imported data. |
| `import:ynab:register` | Imports **transactions** — deletes all rows ≤ cutover date (any source), then imports legacy rows. |

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

**What each script does with `--cutover-date`:**

- **Plan import:** wipes ALL budget assignment rows (any source: manual, template, ynab_import) for months ≤ cutover month, replaces with imported data. Rows for months after cutover are untouched.
- **Register import:** deletes ALL transaction rows (any source) with `date ≤ cutover-date`, then imports legacy transactions up to that date. Transactions after the cutover date are untouched.

This means you can re-import as many times as you like while still working in your legacy system — each run replaces the pre-cutover window cleanly. There is no overlap, no duplicate queue, and no manual review needed.

---

## Typical dev workflow

```bash
# 1. Export plan.csv and register.csv from your legacy system, drop in data/ynab/

# 2. Sync dev sheet (set cutover-date to the last date your export covers)
npm run import:ynab:plan:dev -- --cutover-date 2026-06-01
npm run import:ynab:register:dev -- --cutover-date 2026-06-01

# 3. Run integration tests against dev
npm run test:integration
```

No pre-cleaning of CSV data is required. The scripts handle BOM stripping, emoji normalization, split transaction grouping, and dedup automatically.

---

## Test sheet (seed-test-sheet)

The test sheet is provisioned by `scripts/seed-test-sheet.ts` and is reset before each integration test run — it uses synthetic fixture data, not real exports. You do not need to run the import scripts against the test sheet.

---

## After a sync: what changed

After running both scripts:

| Tab | What changed |
|---|---|
| Budget | All assignment rows for months ≤ cutover replaced with imported data |
| Transactions | All rows ≤ cutover-date deleted; legacy transactions appended with `source:ynab_import` |
| Config | `live_sync_from_date` written (cutover-date + 1 day) |
| Dashboard!B2 | `LastYnabSync` timestamp updated |
| Transactions (seed) | Opening balance rows regenerated from BTS Balance History |

`source:manual` and `source:template` rows after the cutover date are **never touched**.

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
npm run import:ynab:plan:dev -- --file ~/Downloads/my-plan.csv --cutover-date 2026-06-01
npm run import:ynab:register:dev -- --file ~/Downloads/my-register.csv --cutover-date 2026-06-01
```
