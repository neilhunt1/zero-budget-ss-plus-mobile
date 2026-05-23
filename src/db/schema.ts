import Dexie, { type Table } from 'dexie';
import type { Transaction, BudgetCategory, BudgetAssignment, BudgetCalcEntry } from '../types';

export interface SyncMeta {
  key: string;
  lastSyncedAt: string;
  lastSheetVersion: string;
  rowCount: number;
  readyToAssign?: number;
  lastBtsSyncedAt?: string;
}

export class BudgetDatabase extends Dexie {
  transactions!: Table<Transaction>;
  budgetCategories!: Table<BudgetCategory>;
  budgetAssignments!: Table<BudgetAssignment>;
  budgetCalcs!: Table<BudgetCalcEntry>;
  syncMeta!: Table<SyncMeta>;

  constructor() {
    super('btszb');
    this.version(1).stores({
      // Primary keys first, then indexed fields
      transactions: 'transaction_id, date, category, account, reviewed, transaction_type, status',
      budgetCategories: 'category, category_group, active',
      budgetAssignments: '[month+category], month, category, source',
      budgetCalcs: '[month+category], month, category',
      syncMeta: 'key',
    });
  }
}

export const db = new BudgetDatabase();
