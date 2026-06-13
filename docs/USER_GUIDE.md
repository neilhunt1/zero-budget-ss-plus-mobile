# Zero Budget — User Guide

This guide explains how to use Zero Budget day-to-day. It's written for a single user (you, Neil) and assumes the app is already set up and syncing.

---

## Table of Contents

1. [Triage](#triage)
2. [Accounts & Transactions](#accounts--transactions) *(placeholder)*
3. [Manual Transaction Entry](#manual-transaction-entry) *(placeholder)*
4. [Budget / Plan](#budget--plan) *(placeholder)*
5. [Reflect](#reflect) *(placeholder)*
6. [Syncing with BankToSheets](#syncing-with-banksheets) *(placeholder)*

---

## Triage

Triage is where you review and classify imported transactions. Think of it as your inbox — you work through it until it's empty, then you're done.

### What shows up in Triage

The Triage queue contains any transaction that hasn't been reviewed yet. This includes:

- **Purchases** that need a budget category assigned
- **Income** that needs to be approved (so it can be assigned to Ready to Assign)
- **Transfers** between your accounts that need to be confirmed
- **Credit card payments** that need to be linked

Transactions you entered manually do *not* go into the Triage queue — you already thought about them when you entered them.

### The counter ("X of Y")

The header shows your position in the queue (`1 of 5`, etc.). The number in the nav bar badge matches the total count of items needing your attention, which includes:

- Unreviewed imported transactions (the main queue)
- Manual transactions that haven't cleared in 14+ days (see [Stale manual transactions](#stale-manual-transactions) below)

### Working through the queue

Each transaction shows as a card. The card type depends on what Zero Budget thinks the transaction is:

| Card type | What it means | Your action |
|---|---|---|
| 🛒 Purchase | An expense that needs a category | Pick a category, tap **Assign** |
| 💰 Income | Money coming in | Tap **Approve** to move it to Ready to Assign |
| ↔️ Transfer | Money moving between your accounts | Tap **Confirm** |
| 💳 CC Payment | A credit card payment | Tap **Confirm** |
| ❓ Unknown | Zero Budget isn't sure | Pick the correct type from the buttons |

**Suggested category:** For purchases, Zero Budget suggests a category based on where you've sent money from this payee before. The suggestion is pre-selected if it exists. You can override it by picking any other category.

**Ready to Assign:** You can also assign a purchase directly to Ready to Assign if you haven't decided on a category yet. It appears as an italic option at the top of the category list.

**Skip:** Use the Skip button (or the › arrow in the header) to come back to a transaction later. You can also navigate backwards with Back / ‹.

**"Not a purchase / income / transfer / CC payment":** If Zero Budget got the type wrong, tap the escape hatch at the bottom of the card to switch it to a different type.

### Stale manual transactions

If you entered a transaction manually (e.g. you wrote a check and logged it immediately) but the bank never imported a matching transaction within 14 days, Zero Budget surfaces a warning banner at the top of Triage:

> ⚠️ 2 manual transactions haven't cleared in 14+ days

Tap the banner to expand the list. For each stale transaction you can:

- **Delete** — remove it entirely if the transaction never happened or was entered in error

If the transaction really did clear but wasn't matched automatically, go to the Accounts screen to find it and link it manually *(linking UI: placeholder — not yet implemented)*.

### When you're done

When all transactions are reviewed, Triage shows a 🎉 "All caught up!" screen. The nav badge disappears. If there are stale manual transactions, the warning banner still appears here as a reminder.

---

## Accounts & Transactions

*(Placeholder — to be written when the Accounts screen is more complete.)*

Topics to cover:
- Transaction list: filters (All / Unreviewed / Pending), search
- Unreviewed vs. Pending chips
- Editing a transaction inline (category, memo, type)
- The 🔗 matched indicator for manual transactions that cleared
- Split transactions

---

## Manual Transaction Entry

*(Placeholder — to be written when the manual entry form is built, issue #16.)*

Topics to cover:
- How to enter a transaction before it clears
- What "Uncleared" means and how it affects your budget
- How automatic matching works when BTS imports the cleared version
- Approving a matched transaction
- What happens if no match arrives within 14 days

---

## Budget / Plan

*(Placeholder — to be written when the Plan screen is complete.)*

Topics to cover:
- Assigning money to categories
- Ready to Assign
- Group budgets vs. category budgets
- Rollover
- Applying a template

---

## Reflect

*(Placeholder — to be written after the Reflect screen is finalized.)*

Topics to cover:
- Spending overview: time range, pie chart, bar chart
- Filtering by category
- What counts as "spending" (transfers and CC payments excluded)

---

## Syncing with BankToSheets

*(Placeholder — see [ynab-sync-runbook.md](ynab-sync-runbook.md) for the YNAB migration runbook.)*

Topics to cover:
- How BTS syncs automatically
- What to do when a transaction comes in with the wrong account name
- Manual re-sync
