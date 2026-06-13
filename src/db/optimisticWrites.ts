import { db } from './schema';
import { updateTransactionFields, appendTransactions } from '../api/transactions';
import type { SheetsClient } from '../api/client';
import type { Transaction, BudgetCategory, TransactionType } from '../types';

interface SplitLine {
  payee: string;
  category: string;
  category_group: string;
  category_subgroup: string;
  category_type: string;
  amount: number;
  /** Set when editing an existing child row (its transaction_id). */
  _childId?: string;
  /** Set when editing an existing child row (its _rowIndex, 0 = unsynced). */
  _childRowIndex?: number;
}

/**
 * Approve a transaction as income.
 * Updates IndexedDB immediately (instant UI), then writes to Sheets.
 * On Sheets failure, reverts the IndexedDB change and re-throws.
 */
export async function optimisticApproveIncome(
  tx: Transaction,
  client: SheetsClient
): Promise<void> {
  const updates: Partial<Transaction> = {
    reviewed: true,
    transaction_type: 'income' as TransactionType,
    category: '',
    category_group: '',
    category_type: '',
  };
  await db.transactions.update(tx.transaction_id, updates);
  try {
    await updateTransactionFields(client, tx._rowIndex, updates);
  } catch (e) {
    await db.transactions.put(tx);
    throw e;
  }
}

/**
 * Confirm a transfer or CC payment, optionally linking a matching pair transaction.
 * Updates IndexedDB immediately, then writes to Sheets.
 * On Sheets failure, reverts both the tx and the pair in IndexedDB.
 */
export async function optimisticConfirmTransfer(
  tx: Transaction,
  pair: Transaction | null,
  client: SheetsClient,
  type: TransactionType = 'transfer'
): Promise<void> {
  const updates: Partial<Transaction> = {
    reviewed: true,
    transaction_type: type,
    ...(pair ? { transfer_pair_id: pair.transaction_id } : {}),
  };
  await db.transactions.update(tx.transaction_id, updates);
  if (pair && !pair.transfer_pair_id) {
    await db.transactions.update(pair.transaction_id, { transfer_pair_id: tx.transaction_id });
  }
  try {
    await updateTransactionFields(client, tx._rowIndex, updates);
    if (pair && !pair.transfer_pair_id) {
      await updateTransactionFields(client, pair._rowIndex, {
        transfer_pair_id: tx.transaction_id,
      });
    }
  } catch (e) {
    await db.transactions.put(tx);
    if (pair) await db.transactions.put(pair);
    throw e;
  }
}

/**
 * Edit arbitrary fields on an existing transaction.
 * Updates IndexedDB immediately, then writes to Sheets.
 * On Sheets failure, reverts IndexedDB and re-throws.
 */
export async function optimisticEditTransaction(
  tx: Transaction,
  changes: Partial<Transaction>,
  client: SheetsClient
): Promise<void> {
  await db.transactions.update(tx.transaction_id, changes);
  try {
    await updateTransactionFields(client, tx._rowIndex, changes);
  } catch (e) {
    await db.transactions.put(tx);
    throw e;
  }
}

/**
 * Convert a single transaction into a split: update the parent and append child rows.
 * Updates IndexedDB immediately, then writes to Sheets.
 * On Sheets failure, reverts the parent and deletes the children from IndexedDB.
 */
export async function optimisticSplitTransaction(
  parent: Transaction,
  splits: SplitLine[],
  client: SheetsClient
): Promise<void> {
  const splitGroupId = crypto.randomUUID();
  const now = new Date().toISOString();

  const parentUpdates: Partial<Transaction> = {
    split_group_id: splitGroupId,
    category: '',
    category_group: '',
    category_subgroup: '',
    category_type: '',
    reviewed: true,
  };

  const children: (Omit<Transaction, '_rowIndex'> & { _rowIndex: number })[] = splits.map((s, i) => ({
    transaction_id: `SPLIT-${parent.transaction_id}-${i + 1}`,
    parent_id: parent.transaction_id,
    split_group_id: splitGroupId,
    source: parent.source,
    external_id: '',
    imported_at: now,
    status: parent.status,
    date: parent.date,
    payee: s.payee,
    description: '',
    category: s.category,
    suggested_category: '',
    category_subgroup: s.category_subgroup,
    category_group: s.category_group,
    category_type: s.category_type as Transaction['category_type'],
    amount: s.amount,
    account: parent.account,
    memo: '',
    transaction_type: 'regular' as TransactionType,
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: true,
    _rowIndex: 0,
  }));

  await db.transactions.update(parent.transaction_id, parentUpdates);
  await db.transactions.bulkPut(children);

  try {
    // Use INSERT_ROWS so child rows are physically inserted regardless of how
    // Google Sheets detects the table extent. OVERWRITE can silently no-op if
    // the anchor detection is thrown off by the parent row's cleared fields.
    await updateTransactionFields(client, parent._rowIndex, parentUpdates);
    await appendTransactions(client, children);
  } catch (e) {
    await db.transactions.put(parent);
    await db.transactions.bulkDelete(children.map((c) => c.transaction_id));
    throw e;
  }
}

/**
 * Edit the split children of an already-split transaction.
 * Handles: updating existing children in place, appending new ones.
 * Removing existing children is not supported (requires row deletion).
 * Children with _rowIndex === 0 (not yet synced) are updated in IndexedDB only.
 */
export async function optimisticEditSplitChildren(
  parent: Transaction,
  existingChildren: Transaction[],
  splits: SplitLine[],
  client: SheetsClient
): Promise<void> {
  const now = new Date().toISOString();
  const existingById = new Map(existingChildren.map((c) => [c.transaction_id, c]));

  // Partition into: update existing vs. create new
  const toUpdate: Array<{ child: Transaction; changes: Partial<Transaction> }> = [];
  const toCreate: (Omit<Transaction, '_rowIndex'> & { _rowIndex: number })[] = [];

  for (const split of splits) {
    if (split._childId && existingById.has(split._childId)) {
      const child = existingById.get(split._childId)!;
      toUpdate.push({
        child,
        changes: {
          payee: split.payee,
          category: split.category,
          category_group: split.category_group,
          category_subgroup: split.category_subgroup,
          category_type: split.category_type as Transaction['category_type'],
          amount: split.amount,
        },
      });
    } else {
      toCreate.push({
        transaction_id: `SPLIT-${parent.transaction_id}-X${crypto.randomUUID().slice(0, 8)}`,
        parent_id: parent.transaction_id,
        split_group_id: parent.split_group_id,
        source: parent.source,
        external_id: '',
        imported_at: now,
        status: parent.status,
        date: parent.date,
        payee: split.payee,
        description: '',
        category: split.category,
        suggested_category: '',
        category_subgroup: split.category_subgroup,
        category_group: split.category_group,
        category_type: split.category_type as Transaction['category_type'],
        amount: split.amount,
        account: parent.account,
        memo: '',
        transaction_type: 'regular' as TransactionType,
        transfer_pair_id: '',
        flag: '',
        needs_reimbursement: false,
        reimbursement_amount: 0,
        matched_id: '',
        reviewed: true,
        _rowIndex: 0,
      });
    }
  }

  // Optimistic IndexedDB writes
  for (const { child, changes } of toUpdate) {
    await db.transactions.update(child.transaction_id, changes);
  }
  if (toCreate.length > 0) {
    await db.transactions.bulkPut(toCreate);
  }

  try {
    // Sheets writes — skip children with _rowIndex === 0 (unsynced)
    for (const { child, changes } of toUpdate) {
      if (child._rowIndex > 0) {
        await updateTransactionFields(client, child._rowIndex, changes);
      }
    }
    if (toCreate.length > 0) {
      await appendTransactions(client, toCreate);
    }
  } catch (e) {
    // Revert
    for (const { child } of toUpdate) {
      await db.transactions.put(child);
    }
    if (toCreate.length > 0) {
      await db.transactions.bulkDelete(toCreate.map((c) => c.transaction_id));
    }
    throw e;
  }
}

/**
 * Assign a category to a purchase transaction.
 * Updates IndexedDB immediately, then writes to Sheets.
 * On Sheets failure, reverts IndexedDB and re-throws.
 */
export async function optimisticAssignPurchase(
  tx: Transaction,
  category: string,
  catRecord: BudgetCategory | undefined,
  client: SheetsClient
): Promise<void> {
  const updates: Partial<Transaction> = {
    reviewed: true,
    transaction_type: 'regular' as TransactionType,
    category,
    category_group: catRecord?.category_group ?? '',
    category_type: catRecord?.category_type ?? '',
  };
  await db.transactions.update(tx.transaction_id, updates);
  try {
    await updateTransactionFields(client, tx._rowIndex, updates);
  } catch (e) {
    await db.transactions.put(tx);
    throw e;
  }
}
