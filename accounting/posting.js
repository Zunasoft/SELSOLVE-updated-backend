// Nothing in the POS writes to the journal directly — every event funnels through the helpers here so accounting treatment lives in exactly one place.

const engine = require('./engine');
const { r2, bySystemKey, resolveAccount, ensurePartyAccount, postJournal } = engine;

// GST splits CGST/SGST for intra-state supply, wholly to IGST for inter-state — standard Indian retail treatment.
function splitGst(amount, interState = false) {
  const total = r2(amount);
  if (total === 0) return { cgst: 0, sgst: 0, igst: 0, total: 0 };
  if (interState) return { cgst: 0, sgst: 0, igst: total, total };
  const half = r2(total / 2);
  return { cgst: half, sgst: r2(total - half), igst: 0, total };
}

function gstLines(store, amount, { interState = false, input = false, reverse = false } = {}) {
  const { cgst, sgst, igst } = splitGst(amount, interState);
  const suffix = input ? '_INPUT' : '_OUTPUT';
  let side = input ? 'debit' : 'credit';
  if (reverse) side = side === 'debit' ? 'credit' : 'debit';
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

// Sales
// Dr Cash/Bank/Customer + Discount Allowed = Cr Sales + GST Payable +/- Rounding Off.
function postSale(store, order, { customer, interState = false, createdBy } = {}) {
  const subtotal = r2(order.subtotal);
  const discount = r2(order.discount);
  const tax = r2(order.tax);
  const total = r2(order.total);
  const advanceRedeemed = r2(order.advanceRedeemed || 0);
  const loyaltyRedeemed = r2(order.loyaltyRedeemed || 0);
  const effectiveSettled = r2(total + advanceRedeemed + loyaltyRedeemed);
  const rounding = r2(effectiveSettled - (subtotal - discount + tax));

  let partyId = null;
  if (customer && (isCreditSale(order.paymentMethod) || advanceRedeemed > 0)) {
    partyId = customer.id;
  }

  const lines = [
    { accountId: bySystemKey(store, 'DISCOUNT_ALLOWED')?.id, debit: r2(discount + loyaltyRedeemed) },
    { accountId: bySystemKey(store, 'SALES')?.id, credit: subtotal },
    ...gstLines(store, tax, { interState, input: false })
  ];

  if (advanceRedeemed > 0 && customer) {
    const partyAccount = ensurePartyAccount(store, customer, 'CUSTOMER');
    lines.unshift({
      accountId: partyAccount.id,
      debit: advanceRedeemed,
      partyId: customer.id,
      narration: `Advance adjusted against Invoice ${order.orderId}`
    });
  }

  // paidAmount/balanceDue (not paymentMethod alone) drive the Cash-vs-AR split, so a partial-payment sale doesn't book the entire total to Cash; missing paidAmount (legacy quotation-convert path) falls back to fully collected.
  if (total > 0) {
    const paidPortion = r2(Math.max(0, Math.min(total, Number(order.paidAmount ?? total))));
    let duePortion = r2(Math.max(0, total - paidPortion));
    if (duePortion > 0 && !customer) {
      // No party to carry the receivable on, so fold it back into the settlement line instead of dropping it from the books.
      duePortion = 0;
    }
    const settledPortion = r2(total - duePortion);

    if (duePortion > 0) {
      const partyAccount = ensurePartyAccount(store, customer, 'CUSTOMER');
      partyId = customer.id;
      lines.unshift({
        accountId: partyAccount.id,
        debit: duePortion,
        partyId: customer.id,
        narration: `Invoice ${order.orderId} — balance due`
      });
    }

    if (settledPortion > 0) {
      // A split/multi-pay sale books each method's share to its own ledger instead of dumping it all into whatever order.paymentMethod's composite label ('Split Payment') would resolve to.
      const paymentRows = (order.payments || []).filter((p) => Number(p.amount) > 0);
      if (paymentRows.length > 1) {
        const byAccount = new Map();
        let remaining = settledPortion;
        for (const p of paymentRows) {
          if (remaining <= 0) break;
          const amt = r2(Math.min(remaining, Number(p.amount) || 0));
          if (amt <= 0) continue;
          const acc = settlementAccount(store, p.paymentMethod, order.settlementAccountId);
          if (!acc?.id) continue;
          byAccount.set(acc.id, r2((byAccount.get(acc.id) || 0) + amt));
          remaining = r2(remaining - amt);
        }
        if (remaining > 0) {
          const fallback = settlementAccount(store, order.paymentMethod, order.settlementAccountId);
          if (fallback?.id) byAccount.set(fallback.id, r2((byAccount.get(fallback.id) || 0) + remaining));
        }
        for (const [accountId, amt] of byAccount) {
          if (amt > 0) lines.unshift({ accountId, debit: amt, narration: `Invoice ${order.orderId}` });
        }
      } else {
        const debitAccount = settlementAccount(store, order.paymentMethod, order.settlementAccountId);
        lines.unshift({
          accountId: debitAccount.id,
          debit: settledPortion,
          narration: `Invoice ${order.orderId}`
        });
      }
    }
  }

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

  // purchasePrice is per base unit, so cost must use item.baseQty, not the as-sold item.qty (e.g. grams vs kg) — else COGS can be overstated by orders of magnitude.
  const cogsAmount = r2(
    (order.items || []).reduce((sum, item) => {
      const product = (store.products || []).find((p) => p.id === item.id || p.name === item.name);
      const cost = Number(item.purchasePrice ?? product?.purchasePrice ?? 0);
      const qty = Number(item.baseQty ?? item.qty ?? 0);
      return sum + cost * qty;
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

// Reverses the exact accounting a sale would have booked for the returned value (mirrors postPurchaseReturn on the other side of the ledger).
function postSalesReturn(store, creditNote, { customer, interState = false, createdBy } = {}) {
  const taxable = r2(creditNote.subtotal);
  const tax = r2(creditNote.tax);
  const total = r2(creditNote.totalAmount ?? taxable + tax);

  let creditAccount;
  let partyId = null;
  if (customer) {
    const partyAccount = ensurePartyAccount(store, customer, 'CUSTOMER');
    creditAccount = partyAccount;
    partyId = customer.id;
  } else {
    creditAccount = settlementAccount(store, 'Cash');
  }

  const lines = [
    { accountId: bySystemKey(store, 'SALES')?.id, debit: taxable },
    ...gstLines(store, tax, { interState, input: false, reverse: true }),
    {
      accountId: creditAccount.id,
      credit: total,
      partyId,
      narration: `Return against ${creditNote.orderId || 'invoice'}`
    }
  ];

  const voucher = postJournal(store, {
    type: 'SALES_RETURN',
    date: creditNote.date,
    narration: `Credit note ${creditNote.id} — ${creditNote.customerName || 'Customer'} (${creditNote.reason || 'Return'})`,
    refType: 'CREDIT_NOTE',
    refId: creditNote.id,
    partyId,
    createdBy,
    lines: lines.filter((l) => l.accountId)
  });

  // Inventory value comes back in step with the sale's own COGS voucher.
  const cogsAmount = r2(
    (creditNote.items || []).reduce((sum, l) => sum + Number(l.costPrice || 0) * Number(l.baseQty ?? l.qty ?? 0), 0)
  );
  let cogsVoucher = null;
  if (cogsAmount > 0) {
    cogsVoucher = postJournal(store, {
      type: 'SALES_RETURN',
      date: creditNote.date,
      narration: `Cost reversal for credit note ${creditNote.id}`,
      refType: 'CREDIT_NOTE_COGS',
      refId: creditNote.id,
      createdBy,
      lines: [
        { accountId: bySystemKey(store, 'INVENTORY')?.id, debit: cogsAmount },
        { accountId: bySystemKey(store, 'COGS')?.id, credit: cogsAmount }
      ].filter((l) => l.accountId)
    });
  }

  return { voucher, cogsVoucher, cogsAmount };
}

// Purchases
// Dr Stock in Hand + GST Input Credit = Cr Vendor (or Cash/Bank).
function postPurchase(store, purchase, { vendor, interState = false, createdBy } = {}) {
  const taxable = r2(purchase.subtotal ?? purchase.totalAmount);
  const tax = r2(purchase.tax);
  const total = r2(purchase.totalAmount ?? taxable + tax);
  const paid = r2(purchase.paidAmount !== undefined ? purchase.paidAmount : (purchase.paymentStatus === 'PAID' ? total : 0));
  const due = r2(Math.max(0, total - paid));

  let partyId = null;
  const lines = [
    { accountId: bySystemKey(store, 'INVENTORY')?.id, debit: taxable },
    ...gstLines(store, tax, { interState, input: true })
  ];

  if (paid > 0) {
    const payAcc = settlementAccount(store, purchase.paymentMode, purchase.settlementAccountId);
    lines.push({ accountId: payAcc.id, credit: paid, narration: `Purchase ${purchase.invoiceNo} (Paid)` });
  }

  if (due > 0 && vendor) {
    const partyAccount = ensurePartyAccount(store, vendor, 'VENDOR');
    partyId = vendor.id;
    lines.push({ accountId: partyAccount.id, credit: due, partyId, narration: `Purchase ${purchase.invoiceNo} (Payable)` });
  } else if (due > 0) {
    const payAcc = settlementAccount(store, 'Cash');
    lines.push({ accountId: payAcc.id, credit: due, narration: `Purchase ${purchase.invoiceNo}` });
  }

  const rounding = r2(total - (taxable + tax));
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

// Reverses the exact accounting a purchase would have booked: Dr Vendor = Cr Stock in Hand + GST Input Credit.
function postPurchaseReturn(store, vendorCredit, { vendor, interState = false, createdBy } = {}) {
  const taxable = r2(vendorCredit.subtotal);
  const tax = r2(vendorCredit.tax);
  const total = r2(vendorCredit.totalAmount ?? taxable + tax);

  const partyAccount = ensurePartyAccount(store, vendor, 'VENDOR');

  const lines = [
    {
      accountId: partyAccount.id,
      debit: total,
      partyId: vendor.id,
      narration: `Return against ${vendorCredit.purchaseInvoiceNo || 'purchase'}`
    },
    { accountId: bySystemKey(store, 'INVENTORY')?.id, credit: taxable },
    ...gstLines(store, tax, { interState, input: true, reverse: true })
  ];

  return postJournal(store, {
    type: 'PURCHASE_RETURN',
    date: vendorCredit.date,
    narration: `Vendor credit ${vendorCredit.id} — ${vendorCredit.vendorName || 'Vendor'} (${vendorCredit.reason || 'Return'})`,
    refType: 'VENDOR_CREDIT',
    refId: vendorCredit.id,
    partyId: vendor.id,
    createdBy,
    lines: lines.filter((l) => l.accountId)
  });
}

// Freight/customs/handling on a purchase: capitalised into inventory (already allocated per-unit by the caller) rather than expensed, per standard landed-cost treatment.
function postLandedCost(store, purchase, { amount, settlementAccountId, paymentMode, createdBy } = {}) {
  const value = r2(amount);
  if (value <= 0) return null;

  const creditAccount = settlementAccount(store, paymentMode, settlementAccountId);

  return postJournal(store, {
    type: 'STOCK',
    date: purchase.date,
    narration: `Landed cost (freight/handling) for purchase ${purchase.invoiceNo}`,
    refType: 'LANDED_COST',
    refId: purchase.id,
    paymentMode,
    createdBy,
    lines: [
      { accountId: bySystemKey(store, 'INVENTORY')?.id, debit: value },
      { accountId: creditAccount.id, credit: value }
    ].filter((l) => l.accountId)
  });
}

// Expenses & other income
// Dr Expense head + GST Input Credit = Cr Cash/Bank (paid) or Vendor (unpaid).
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

// Other income (bank interest, commission, scrap sales): Dr Cash/Bank = Cr Income head.
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

// Money movement
// Customer receipt: a settlement discount, if any, is expensed rather than netted against sales so revenue stays clean.
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

// Vendor payment settles a payable, never a fresh expense — booking it as an expense would double-count, so the debit goes to the vendor.
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

// Vendor repayment/refund: Dr Cash/Bank = Cr Vendor Account (debt cleared).
function postVendorRefund(store, { amount, vendor, notes, createdBy } = {}) {
  const value = r2(amount);
  const partyAccount = ensurePartyAccount(store, vendor, 'VENDOR');
  const cash = bySystemKey(store, 'CASH') || { id: 'acc_cash' };

  return postJournal(store, {
    type: 'RECEIPT',
    date: new Date().toISOString(),
    narration: notes || `Cash debt repayment / refund from ${vendor.name}`,
    refType: 'VENDOR_REFUND',
    partyId: vendor.id,
    paymentMode: 'Cash',
    createdBy,
    lines: [
      { accountId: cash.id, debit: value },
      { accountId: partyAccount.id, credit: value, partyId: vendor.id, narration: `Cash repayment from ${vendor.name}` }
    ].filter((l) => l.accountId)
  });
}

// Applies against the vendor's oldest unpaid/partial invoices first; matches by both vendorId and vendorName for robust alignment.
function applyVendorPaymentToPurchases(store, vendor, amount, discount = 0) {
  let remaining = r2(Number(amount || 0) + Number(discount || 0));
  const settled = [];
  const vendorNameLower = vendor?.name ? String(vendor.name).trim().toLowerCase() : '';

  (store.purchases || [])
    .filter((p) => {
      const idMatch = vendor?.id && p.vendorId === vendor.id;
      const nameMatch = vendorNameLower && p.vendorName && String(p.vendorName).trim().toLowerCase() === vendorNameLower;
      return (idMatch || nameMatch) && p.paymentStatus !== 'PAID' && p.status !== 'VOID';
    })
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    .forEach((purchase) => {
      if (remaining <= 0.009) return;
      const due = r2((Number(purchase.totalAmount) || 0) - (Number(purchase.paidAmount) || 0));
      const applied = Math.min(due, remaining);
      purchase.paidAmount = r2((Number(purchase.paidAmount) || 0) + applied);
      purchase.paymentStatus = purchase.paidAmount >= (Number(purchase.totalAmount) || 0) - 0.009 ? 'PAID' : 'PARTIAL';
      remaining = r2(remaining - applied);
      settled.push({ invoiceNo: purchase.invoiceNo, applied, status: purchase.paymentStatus });
    });

  return settled;
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

// The contra leg is Opening Balance Equity, keeping the trial balance square while balances are still being entered.
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

// Deliberately its own type/refType rather than reusing postOpeningBalance — reusing it would make every later correction keep summing into "Opening Balance" on the statement, inflating it with each edit.
function postBalanceAdjustment(store, { accountId: accId, amount, side, date, createdBy, narration }) {
  const account = resolveAccount(store, accId);
  if (!account) throw new Error('Account not found.');
  const value = r2(amount);
  if (value === 0) throw new Error('Adjustment amount must be non-zero.');

  const equity = bySystemKey(store, 'OPENING_EQUITY');
  const isDebit = String(side).toUpperCase() === 'DR';

  return postJournal(store, {
    type: 'BALANCE_ADJUSTMENT',
    date: date || new Date().toISOString(),
    narration: narration || `Balance adjustment — ${account.name}`,
    refType: 'BALANCE_ADJUSTMENT',
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

// Increases capitalise into inventory against the equity suspense; shrinkage/damage are written off to the P&L.
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
  postSalesReturn,
  postPurchase,
  postPurchaseReturn,
  postLandedCost,
  postExpense,
  postIncome,
  postReceipt,
  postPayment,
  applyVendorPaymentToPurchases,
  postVendorRefund,
  postFundTransfer,
  postOpeningBalance,
  postBalanceAdjustment,
  postStockAdjustment
};
