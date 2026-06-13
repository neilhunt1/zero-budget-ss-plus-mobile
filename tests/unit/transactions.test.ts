import { describe, it, expect } from 'vitest';
import { computeCategoryActivity, classifyTransactionType, findCcPaymentPair } from '../../src/api/transactions';
import { Transaction } from '../../src/types/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _id = 1;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: `tx-${_id++}`,
    parent_id: '',
    split_group_id: '',
    source: 'manual',
    external_id: '',
    imported_at: '',
    status: 'cleared',
    date: '2025-04-01',
    payee: 'Test Payee',
    description: '',
    category: 'Groceries',
    suggested_category: '',
    category_subgroup: '',
    category_group: 'Food & Dining',
    category_type: 'fluid',
    amount: 0,
    account: 'Checking',
    memo: '',
    transaction_type: 'debit',
    transfer_pair_id: '',
    flag: '',
    needs_reimbursement: false,
    reimbursement_amount: 0,
    matched_id: '',
    reviewed: false,
    _rowIndex: 2,
    ...overrides,
  };
}

// ─── computeCategoryActivity ──────────────────────────────────────────────────

describe('computeCategoryActivity', () => {
  it('returns activity = -amount per category (outflow is negative amount)', () => {
    const txs = [makeTx({ category: 'Groceries', amount: -120 })];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(120);
  });

  it('subtracts inflow from outflow (refund has positive amount, reduces activity)', () => {
    const txs = [
      makeTx({ category: 'Dining Out', amount: -80 }),
      makeTx({ category: 'Dining Out', amount: 20 }), // refund
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Dining Out')).toBe(60);
  });

  it('accumulates multiple transactions in the same category', () => {
    const txs = [
      makeTx({ category: 'Groceries', amount: -200 }),
      makeTx({ category: 'Groceries', amount: -150 }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(350);
  });

  it('tracks multiple categories independently', () => {
    const txs = [
      makeTx({ category: 'Groceries', amount: -300 }),
      makeTx({ category: 'Gas', amount: -60 }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.get('Groceries')).toBe(300);
    expect(result.get('Gas')).toBe(60);
  });

  it('excludes transfer transactions entirely', () => {
    const txs = [
      makeTx({ category: 'Savings', amount: -1000, transaction_type: 'transfer' }),
    ];
    const result = computeCategoryActivity(txs);
    expect(result.has('Savings')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('excludes transactions with no category', () => {
    const txs = [makeTx({ category: '', amount: -50 })];
    const result = computeCategoryActivity(txs);
    expect(result.size).toBe(0);
  });

  it('returns an empty map for an empty transaction list', () => {
    expect(computeCategoryActivity([])).toEqual(new Map());
  });

  it('excludes credit_payment transactions entirely', () => {
    const txs = [makeTx({ category: 'CC Payments', amount: -500, transaction_type: 'credit_payment' })];
    expect(computeCategoryActivity(txs).size).toBe(0);
  });
});

// ─── classifyTransactionType ──────────────────────────────────────────────────

describe('classifyTransactionType', () => {
  it('returns income for stored income type', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: 'income', amount: 500, category: '' }))).toBe('income');
  });

  it('returns transfer for stored transfer type', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: 'transfer', amount: -1000 }))).toBe('transfer');
  });

  it('returns credit_payment for stored credit_payment type', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: 'credit_payment', amount: -500 }))).toBe('credit_payment');
  });

  it('returns regular for stored regular type', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: 'regular', amount: -50 }))).toBe('regular');
  });

  it('maps legacy debit to regular', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: 'debit' as never, amount: -50 }))).toBe('regular');
  });

  it('infers transfer when transfer_pair_id is set and type is blank', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: '', transfer_pair_id: 'other-tx', category: '' }))).toBe('transfer');
  });

  it('infers regular when amount is negative (outflow) and type is blank', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: '', amount: -50, category: '' }))).toBe('regular');
  });

  it('infers regular for positive amount with a category (store return)', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: '', amount: 20, category: 'Groceries' }))).toBe('regular');
  });

  it('returns empty string for uncategorized positive amount with no pair (not auto-classified as income)', () => {
    expect(classifyTransactionType(makeTx({ transaction_type: '', amount: 500, category: '', transfer_pair_id: '' }))).toBe('');
  });
});

// ─── findCcPaymentPair ────────────────────────────────────────────────────────

describe('findCcPaymentPair', () => {
  function makeCcTx(overrides: Partial<Transaction> = {}): Transaction {
    return makeTx({ transaction_type: 'credit_payment', ...overrides });
  }

  it('finds a matching CC payment pair between depository and credit accounts', () => {
    const payment = makeCcTx({ transaction_id: 'p1', account: 'Capital One 360 Checking (6650)', amount: -500, date: '2025-05-01' });
    const receipt = makeCcTx({ transaction_id: 'p2', account: 'Chase CREDIT CARD (2898)', amount: 500, date: '2025-05-01' });
    expect(findCcPaymentPair(payment, [payment, receipt])).toBe(receipt);
  });

  it('finds pair when receipt comes first', () => {
    const receipt = makeCcTx({ transaction_id: 'p1', account: 'Chase CREDIT CARD (2898)', amount: 300, date: '2025-05-02' });
    const payment = makeCcTx({ transaction_id: 'p2', account: 'Capital One 360 Checking (6650)', amount: -300, date: '2025-05-02' });
    expect(findCcPaymentPair(receipt, [receipt, payment])).toBe(payment);
  });

  it('finds pair within 3 days', () => {
    const payment = makeCcTx({ transaction_id: 'p1', account: 'Capital One 360 Checking (6650)', amount: -200, date: '2025-05-01' });
    const receipt = makeCcTx({ transaction_id: 'p2', account: 'Chase CREDIT CARD (2898)', amount: 200, date: '2025-05-03' });
    expect(findCcPaymentPair(payment, [payment, receipt])).toBe(receipt);
  });

  it('does not match when gap exceeds 7 days', () => {
    const payment = makeCcTx({ transaction_id: 'p1', account: 'Capital One 360 Checking (6650)', amount: -200, date: '2025-05-01' });
    const receipt = makeCcTx({ transaction_id: 'p2', account: 'Chase CREDIT CARD (2898)', amount: 200, date: '2025-05-09' });
    expect(findCcPaymentPair(payment, [payment, receipt])).toBeNull();
  });

  it('does not match two depository accounts (bank-to-bank transfer, not CC payment)', () => {
    const tx1 = makeCcTx({ transaction_id: 'p1', account: 'Capital One 360 Checking (6650)', amount: -500, date: '2025-05-01' });
    const tx2 = makeCcTx({ transaction_id: 'p2', account: 'Capital One 360 Performance Savings (6128)', amount: 500, date: '2025-05-01' });
    expect(findCcPaymentPair(tx1, [tx1, tx2])).toBeNull();
  });

  it('does not match when amounts differ by more than $0.01', () => {
    const payment = makeCcTx({ transaction_id: 'p1', account: 'Capital One 360 Checking (6650)', amount: -500, date: '2025-05-01' });
    const receipt = makeCcTx({ transaction_id: 'p2', account: 'Chase CREDIT CARD (2898)', amount: 499, date: '2025-05-01' });
    expect(findCcPaymentPair(payment, [payment, receipt])).toBeNull();
  });
});
