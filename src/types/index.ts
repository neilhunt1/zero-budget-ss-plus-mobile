// ─── Enums / Literals ─────────────────────────────────────────────────────────

export type TransactionStatus = 'cleared' | 'pending' | 'manual';
export type TransactionType = 'debit' | 'credit' | 'transfer';
export type CategoryType = 'fluid' | 'fixed_bill' | 'savings_target';

// ─── Core Domain Types ─────────────────────────────────────────────────────────

export interface Transaction {
  transaction_id: string;
  parent_id: string;
  split_group_id: string;
  source: string;
  external_id: string;
  imported_at: string;
  status: TransactionStatus;
  date: string; // ISO date YYYY-MM-DD
  payee: string;
  description: string;
  category: string;
  suggested_category: string;
  category_subgroup: string;
  category_group: string;
  category_type: CategoryType | '';
  outflow: number;
  inflow: number;
  account: string;
  memo: string;
  transaction_type: TransactionType | '';
  transfer_pair_id: string;
  flag: string;
  needs_reimbursement: boolean;
  reimbursement_amount: number;
  matched_id: string;
  reviewed: boolean;
  /** 1-based row index in the Transactions sheet (used for in-place updates) */
  _rowIndex: number;
}

export interface BudgetCategory {
  category_group: string;
  category_subgroup: string;
  category: string;
  category_type: CategoryType;
  monthly_template_amount: number;
  sort_order: number;
  active: boolean;
  _rowIndex: number;
}

export interface BudgetAssignment {
  month: string; // YYYY-MM
  category: string;
  assigned: number;
  source: string; // 'manual' | 'ynab_import' | 'template'
  _rowIndex: number;
}

export interface Template {
  template_id: string;
  parent_id: string;
  name: string;
  match_payee: string;
  match_amount: number;
  match_account: string;
  active: boolean;
  split_payee: string;
  category: string;
  amount: number;
  _rowIndex: number;
}

// ─── Derived / Computed ────────────────────────────────────────────────────────

/** Pre-calculated activity and available for one category in one month, from Budget_Calcs tab. */
export interface CategoryCalcs {
  activity: number; // outflow − inflow for the month
  available: number; // includes rollover from prior months
}

/** A budget category enriched with computed month values. */
export interface CategoryWithActivity extends BudgetCategory {
  assigned: number;
  activity: number; // outflow − inflow for the month
  available: number; // available for the month (includes rollover from prior months)
}

/** Budget view for a single month, grouped for rendering. */
export interface GroupedBudget {
  groupName: string;
  subgroups: Array<{
    subgroupName: string;
    categories: CategoryWithActivity[];
  }>;
  totalAssigned: number;
  totalActivity: number;
  totalAvailable: number;
}
