/**
 * Auto-posting rules — the bridge between shop-floor events and the ledger.
 *
 * Nothing in the POS writes to the journal directly. Sales, purchases,
 * expenses, receipts and payments all funnel through the helpers here so that
 * the accounting treatment of a transaction lives in exactly one place.
 */

const engine = require('./engine');
const { r2, bySystemKey, resolveAccount, ensurePartyAccount, postJournal } = engine;

/**
 * GST is split CGST/SGST for intra-state supply and booked wholly to IGST for
 * inter-state supply — the standard Indian retail treatment.
 */
function splitGst(amount, interState = false) {
  const total = r2(amount);
  if (total === 0) return { cgst: 0, sgst: 0, igst: 0, total: 0 };
  if (interState) return { cgst: 0, sgst: 0, igst: total, total };
  const half = r2(total / 2);
  return { cgst: half, sgst: r2(total - half), igst: 0, total };
}

function gstLines(store, amount, { interState = false, input = false } = {}) {
  const { cgst, sgst, igst } = splitGst(amount, interState);
  const suffix = input ? '_INPUT' : '_OUTPUT';
  const side = input ? 'debit' : 'credit';
  return [
    { accountId: bySystemKey(store, `CGST${suffix}`)?.id, [side]: cgst },
    { accountId: bySystemKey(store, `SGST${suffix}`)?.id, [side]: sgst },
    { accountId: bySystemKey(store, `IGST${suffix}`)?.id, [side]: igst }
  ].filter((l) => l.accountId);
}

/** Map a POS payment mode to the ledger that actually receives the money. */
function settlementAccount(store, paymentMode, explicitAccountId) {
  if (explicitAccountId) {
    const acc = resolveAccount(store, explicitAccountId);
    if (acc) return acc;
  }
  const mode = String(paymentMode || 'Cash').toLowerCase();
  if (mode.includes('cash')) return bySystemKey(store, 'CASH');

  // UPI / Card / Bank Transfer land in the default (first) bank ledger.
  const bank = (store.accounts || []).find((a) => a.systemKey === 'BANK' && a.isActive);
  return bank || bySystemKey(store, 'CASH');
}

const isCreditSale = (mode) => String(mode || '').toLowerCase().includes('credit');

/* ------------------------------------------------------------------ *
 * Sales
 * ------------------------------------------------------------------ */

/**
 * Sale voucher.
 *   Dr Cash / Bank / Customer        gross collected
 *   Dr Discount Allowed              discount given
 *      Cr Sales                      gross item value
 *      Cr GST Payable                tax collected
 *      Cr/Dr Rounding Off            invoice rounding
 */
function postSale(store, order, { customer, interState = false, createdBy } = {}) {
  const subtotal = r2(order.subtotal);
  const discount = r2(order.discount);
  const tax = r2(order.tax);
  const total = r2(order.total);
  const rounding = r2(total - (subtotal - discount + tax));

  let debitAccount;
  let partyId = null;

  if (isCreditSale(order.paymentMethod) && customer) {
    const partyAccount = ensurePartyAccount(store, customer, 'CUSTOMER');
    debitAccount = partyAccount;
    partyId = customer.id;
  } else {
    debitAccount = settlementAccount(store, order.paymentMethod, order.settlementAccountId);
  }

  const lines = [
    { accountId: debitAccount.id, debit: total, partyId, narration: `Invoice ${order.orderId}` },
    { accountId: bySystemKey(store, 'DISCOUNT_ALLOWED')?.id, debit: discount },
    { accountId: bySystemKey(store, 'SALES')?.id, credit: subtotal },
    ...gstLines(store, tax, { interState, input: false })
  ];

  const roundingAcc = bySystemKey(store, 'ROUNDING_OFF');
  if (roundingAcc && rounding !== 0) {
    lines.push(
      rounding > 0
        ? { accountId: roundingAcc.id, credit: rounding }
        : { accountId: roundingAcc.id, debit: r2(-rounding) }
    );
  }

  const voucher = postJournal(store, {
    type: 'SALES',
    date: order.date,
    narration: `Sale ${order.orderId} — ${order.customerName || 'Walk-in Customer'} (${order.paymentMethod})`,
    refType: 'ORDER',
    refId: order.orderId,
    partyId,
    paymentMode: order.paymentMethod,
    createdBy,
    lines: lines.filter((l) => l.accountId)
  });

  // Cost of goods sold moves value out of inventory into the P&L.
  const cogsAmount = r2(
    (order.items || []).reduce((sum, item) => {
      const product = (store.products || []).find((p) => p.id === item.id || p.name === item.name);
      const cost = Number(item.purchasePrice ?? product?.purchasePrice ?? 0);
      return sum + cost * Number(item.qty || 0);
    }, 0)
  );

  let cogsVoucher = null;
  if (cogsAmount > 0) {
    cogsVoucher = postJournal(store, {
      type: 'SALES',
      date: order.date,
      narration: `Cost of goods sold for ${order.orderId}`,
      refType: 'ORDER_COGS',
      refId: order.orderId,
      createdBy,
      lines: [
        { accountId: bySystemKey(store, 'COGS')?.id, debit: cogsAmount },
        { accountId: bySystemKey(store, 'INVENTORY')?.id, credit: cogsAmount }
      ]
    });
  }

  return { voucher, cogsVoucher, cogsAmount };
}

/* ------------------------------------------------------------------ *
 * Purchases
 * ------------------------------------------------------------------ */

/**
 * Purchase invoice.
 *   Dr Stock in Hand                 taxable value
 *   Dr GST Input Credit              tax paid
 *      Cr Vendor (or Cash / Bank)    invoice total
 */
function postPurchase(store, purchase, { vendor, interState = false, createdBy } = {}) {
  const taxable = r2(purchase.subtotal ?? purchase.totalAmount);
  const tax = r2(purchase.tax);
  const total = r2(purchase.totalAmount ?? taxable + tax);

  let creditAccount;
  let partyId = null;

  if (purchase.paymentStatus === 'PAID') {
    creditAccount = settlementAccount(store, purchase.paymentMode, purchase.settlementAccountId);
  } else if (vendor) {
    const partyAccount = ensurePartyAccount(store, vendor, 'VENDOR');
    creditAccount = partyAccount;
    partyId = vendor.id;
  } else {
    creditAccount = settlementAccount(store, 'Cash');
  }

  const rounding = r2(total - (taxable + tax));
  const lines = [
    { accountId: bySystemKey(store, 'INVENTORY')?.id, debit: taxable },
    ...gstLines(store, tax, { interState, input: true }),
    { accountId: creditAccount.id, credit: total, partyId, narration: `Purchase ${purchase.invoiceNo}` }
  ];

  const roundingAcc = bySystemKey(store, 'ROUNDING_OFF');
  if (roundingAcc && rounding !== 0) {
    lines.push(
      rounding > 0
        ? { accountId: roundingAcc.id, debit: rounding }
        : { accountId: roundingAcc.id, credit: r2(-rounding) }
    );
  }

  return postJournal(store, {
    type: 'PURCHASE',
    date: purchase.date,
    narration: `Purchase ${purchase.invoiceNo} — ${purchase.vendorName || 'Vendor'}`,
    refType: 'PURCHASE',
    refId: purchase.id,
    partyId,
    createdBy,
    lines: lines.filter((l) => l.accountId)
  });
}

/* ------------------------------------------------------------------ *
 * Expenses & other income
 * ------------------------------------------------------------------ */

/**
 * Expense.
 *   Dr Expense head          net amount
 *   Dr GST Input Credit      recoverable tax
 *      Cr Cash / Bank        when paid
 *      Cr Vendor             when left unpaid
 */
function postExpense(store, expense, { vendor, createdBy } = {}) {
  const amount = r2(expense.amount);
  const tax = r2(expense.tax);
  const total = r2(amount + tax);

  const expenseAccount =
    resolveAccount(store, expense.accountId) ||
    bySystemKey(store, expense.systemKey) ||
    bySystemKey(store, 'STORE_SUPPLIES');

  let creditAccount;
  let partyId = null;

  if (expense.unpaid && vendor) {
    creditAccount = ensurePartyAccount(store, vendor, 'VENDOR');
    partyId = vendor.id;
  } else {
    creditAccount = settlementAccount(store, expense.paymentMode, expense.settlementAccountId);
  }

  return postJournal(store, {
    type: 'EXPENSE',
    date: expense.date,
    narration: expense.notes
      ? `${expenseAccount.name} — ${expense.notes}`
      : `${expenseAccount.name} expense`,
    refType: 'EXPENSE',
    refId: expense.id,
    partyId,
    paymentMode: expense.paymentMode,
    createdBy,
    lines: [
      { accountId: expenseAccount.id, debit: amount },
      ...gstLines(store, tax, { input: true }),
      { accountId: creditAccount.id, credit: total, partyId }
    ].filter((l) => l.accountId)
  });
}

/**
 * Other income (bank interest, commission, scrap sales).
 *   Dr Cash / Bank
 *      Cr Income head
 */
function postIncome(store, income, { createdBy } = {}) {
  const amount = r2(income.amount);
  const incomeAccount =
    resolveAccount(store, income.accountId) ||
    bySystemKey(store, income.systemKey) ||
    bySystemKey(store, 'OTHER_INCOME');

  const debitAccount = settlementAccount(store, income.paymentMode, income.settlementAccountId);

  return postJournal(store, {
    type: 'INCOME',
    date: income.date,
    narration: income.notes ? `${incomeAccount.name} — ${income.notes}` : `${incomeAccount.name} received`,
    refType: 'INCOME',
    refId: income.id,
    paymentMode: income.paymentMode,
    createdBy,
    lines: [
      { accountId: debitAccount.id, debit: amount },
      { accountId: incomeAccount.id, credit: amount }
    ].filter((l) => l.accountId)
  });
}

/* ------------------------------------------------------------------ *
 * Money movement
 * ------------------------------------------------------------------ */

/**
 * Customer receipt — money in, dues down. A settlement discount, if any, is
 * expensed rather than netted against sales so the revenue figure stays clean.
 */
function postReceipt(store, receipt, { customer, createdBy } = {}) {
  const amount = r2(receipt.amount);
  const discount = r2(receipt.discount);
  const partyAccount = ensurePartyAccount(store, customer, 'CUSTOMER');
  const debitAccount = settlementAccount(store, receipt.paymentMode, receipt.settlementAccountId);

  return postJournal(store, {
    type: 'RECEIPT',
    date: receipt.date,
    narration: receipt.notes || `Receipt from ${customer.name}`,
    refType: 'RECEIPT',
    refId: receipt.id,
    partyId: customer.id,
    paymentMode: receipt.paymentMode,
    createdBy,
    lines: [
      { accountId: debitAccount.id, debit: amount },
      { accountId: bySystemKey(store, 'DISCOUNT_ALLOWED')?.id, debit: discount },
      { accountId: partyAccount.id, credit: r2(amount + discount), partyId: customer.id }
    ].filter((l) => l.accountId)
  });
}

/**
 * Vendor payment — settling a payable, never a fresh expense. Booking it as an
 * expense here is the classic double-count, so the debit goes to the vendor.
 */
function postPayment(store, payment, { vendor, createdBy } = {}) {
  const amount = r2(payment.amount);
  const discount = r2(payment.discount);
  const partyAccount = ensurePartyAccount(store, vendor, 'VENDOR');
  const creditAccount = settlementAccount(store, payment.paymentMode, payment.settlementAccountId);

  return postJournal(store, {
    type: 'PAYMENT',
    date: payment.date,
    narration: payment.notes || `Payment to ${vendor.name}`,
    refType: 'PAYMENT',
    refId: payment.id,
    partyId: vendor.id,
    paymentMode: payment.paymentMode,
    createdBy,
    lines: [
      { accountId: partyAccount.id, debit: r2(amount + discount), partyId: vendor.id },
      { accountId: creditAccount.id, credit: amount },
      { accountId: bySystemKey(store, 'DISCOUNT_RECEIVED')?.id, credit: discount }
    ].filter((l) => l.accountId)
  });
}

/** Fund transfer between two cash/bank ledgers (contra voucher). */
function postFundTransfer(store, transfer, { createdBy } = {}) {
  const amount = r2(transfer.amount);
  const charges = r2(transfer.charges);
  const from = resolveAccount(store, transfer.fromAccountId);
  const to = resolveAccount(store, transfer.toAccountId);

  if (!from || !to) throw new Error('Both source and destination accounts are required.');
  if (from.id === to.id) throw new Error('Source and destination must be different accounts.');

  return postJournal(store, {
    type: 'CONTRA',
    date: transfer.date,
    narration: transfer.notes || `Fund transfer: ${from.name} → ${to.name}`,
    refType: 'TRANSFER',
    refId: transfer.id,
    createdBy,
    lines: [
      { accountId: to.id, debit: amount },
      { accountId: bySystemKey(store, 'BANK_CHARGES')?.id, debit: charges },
      { accountId: from.id, credit: r2(amount + charges) }
    ].filter((l) => l.accountId)
  });
}

/**
 * Opening balance. The contra leg is Opening Balance Equity, which keeps the
 * trial balance square while balances are still being entered.
 */
function postOpeningBalance(store, { accountId: accId, amount, side, date, createdBy }) {
  const account = resolveAccount(store, accId);
  if (!account) throw new Error('Account not found.');
  const value = r2(amount);
  if (value === 0) throw new Error('Opening balance must be non-zero.');

  const equity = bySystemKey(store, 'OPENING_EQUITY');
  const isDebit = String(side).toUpperCase() === 'DR';

  return postJournal(store, {
    type: 'OPENING',
    date: date || new Date().toISOString(),
    narration: `Opening balance — ${account.name}`,
    refType: 'OPENING_BALANCE',
    refId: account.id,
    partyId: account.partyId,
    createdBy,
    lines: [
      isDebit
        ? { accountId: account.id, debit: value, partyId: account.partyId }
        : { accountId: account.id, credit: value, partyId: account.partyId },
      isDebit ? { accountId: equity.id, credit: value } : { accountId: equity.id, debit: value }
    ]
  });
}

/**
 * Stock adjustment. Increases capitalise into inventory against the equity
 * suspense; shrinkage and damage are written off to the P&L.
 */
function postStockAdjustment(store, adjustment, { createdBy } = {}) {
  const value = r2(adjustment.value);
  if (value === 0) return null;

  const inventory = bySystemKey(store, 'INVENTORY');
  const writeOff = bySystemKey(store, 'STOCK_WRITE_OFF');
  const opening = bySystemKey(store, 'OPENING_EQUITY');
  const isIncrease = value > 0;
  const abs = Math.abs(value);

  return postJournal(store, {
    type: 'STOCK',
    date: adjustment.date,
    narration: `Stock adjustment — ${adjustment.productName} (${adjustment.reason})`,
    refType: 'STOCK_ADJUSTMENT',
    refId: adjustment.id,
    createdBy,
    lines: isIncrease
      ? [
          { accountId: inventory.id, debit: abs },
          { accountId: opening.id, credit: abs }
        ]
      : [
          { accountId: writeOff.id, debit: abs },
          { accountId: inventory.id, credit: abs }
        ]
  });
}

module.exports = {
  splitGst,
  gstLines,
  settlementAccount,
  isCreditSale,
  postSale,
  postPurchase,
  postExpense,
  postIncome,
  postReceipt,
  postPayment,
  postFundTransfer,
  postOpeningBalance,
  postStockAdjustment
};
