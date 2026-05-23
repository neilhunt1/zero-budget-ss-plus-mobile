import { db } from './schema';
import { updateTransactionFields } from '../api/transactions';
import type { SheetsClient } from '../api/client';
import type { Transaction, BudgetCategory, TransactionType } from '../types';

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
