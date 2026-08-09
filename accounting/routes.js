/**
 * Accounts module REST API — mounted at /api/pos/accounts.
 *
 * Balances are never stored: every figure returned here is derived live from
 * the journal, so the Chart of Accounts, the party ledgers and the financial
 * statements can never drift out of agreement with one another.
 */

const express = require('express');
const engine = require('./engine');
const posting = require('./posting');

const {
  r2,
  ensureAccounting,
  getAccount,
  bySystemKey,
  resolveAccount,
  accountBalance,
  accountLedger,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  cashFlow,
  partyOutstanding,
  ageing,
  dayBook,
  liquidAccounts,
  createAccount,
  postJournal,
  reverseJournal,
  dayKey
} = engine;

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

router.use((req, res, next) => {
  ensureAccounting(req.tenantStore);
  if (!Array.isArray(req.tenantStore.receipts)) req.tenantStore.receipts = [];
  if (!Array.isArray(req.tenantStore.payments)) req.tenantStore.payments = [];
  if (!Array.isArray(req.tenantStore.transfers)) req.tenantStore.transfers = [];
  if (!Array.isArray(req.tenantStore.incomes)) req.tenantStore.incomes = [];
  next();
});

const actor = (req) => req.user?.name || req.headers['x-user-name'] || 'Owner';
const period = (req) => ({ from: req.query.from || null, to: req.query.to || null });
const fail = (res, err, code = 400) =>
  res.status(code).json({ success: false, message: err.message || String(err) });

const findCustomer = (store, id) =>
  (store.customers || []).find((c) => c.id === id || c.name === id);
const findVendor = (store, id) => (store.vendors || []).find((v) => v.id === id || v.name === id);

/** Nested Chart of Accounts with rolled-up balances at every level. */
function buildAccountTree(store, opts) {
  const accounts = store.accounts || [];
  const byParent = {};
  accounts.forEach((a) => {
    const key = a.parentId || 'root';
    if (!byParent[key]) byParent[key] = [];
    byParent[key].push(a);
  });

  const shape = (account, depth) => {
    const children = (byParent[account.id] || [])
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((c) => shape(c, depth + 1));
    return {
      ...account,
      depth,
      balance: accountBalance(store, account.id, opts),
      childCount: children.length,
      children
    };
  };

  return (byParent.root || [])
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => shape(a, 0));
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

router.get('/dashboard', (req, res) => {
  const store = req.tenantStore;
  const today = dayKey(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;

  const todaysOrders = (store.orders || []).filter((o) => dayKey(o.date) === today);
  const todaysSales = r2(todaysOrders.reduce((s, o) => s + Number(o.total || 0), 0));

  const cash = r2(
    liquidAccounts(store)
      .filter((a) => a.systemKey === 'CASH')
      .reduce((s, a) => s + accountBalance(store, a.id), 0)
  );
  const bank = r2(
    liquidAccounts(store)
      .filter((a) => a.systemKey === 'BANK')
      .reduce((s, a) => s + accountBalance(store, a.id), 0)
  );

  const receivables = r2(
    partyOutstanding(store, 'CUSTOMER').reduce((s, p) => s + Math.max(0, p.balance), 0)
  );
  const payables = r2(
    partyOutstanding(store, 'VENDOR').reduce((s, p) => s + Math.max(0, p.balance), 0)
  );

  const monthly = profitAndLoss(store, { from: monthStart, to: today });

  const topExpenses = monthly.expenses.lines
    .filter((l) => l.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  // Twelve-week sales/expense trend for the dashboard chart.
  const trend = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const mPl = profitAndLoss(store, { from: `${key}-01`, to: `${key}-31` });
    trend.push({
      month: d.toLocaleString('en-IN', { month: 'short' }),
      income: mPl.totalIncome,
      expense: mPl.totalExpenses,
      profit: mPl.netProfit
    });
  }

  const tb = trialBalance(store, {});
  const bs = balanceSheet(store, {});

  res.json({
    success: true,
    data: {
      todaysSales,
      todaysBills: todaysOrders.length,
      cashInHand: cash,
      bankBalance: bank,
      receivables,
      payables,
      monthlyIncome: monthly.totalIncome,
      monthlyExpenses: monthly.totalExpenses,
      monthlyProfit: monthly.netProfit,
      grossProfit: monthly.grossProfit,
      grossMargin: monthly.grossMargin,
      topExpenses,
      trend,
      outstandingCustomers: partyOutstanding(store, 'CUSTOMER').slice(0, 6),
      outstandingVendors: partyOutstanding(store, 'VENDOR').slice(0, 6),
      recentVouchers: (store.journal || []).slice(0, 8),
      health: {
        booksBalanced: tb.isBalanced && bs.isBalanced,
        trialBalanceDifference: tb.difference,
        balanceSheetDifference: bs.difference,
        voucherCount: (store.journal || []).length,
        accountCount: (store.accounts || []).length
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Chart of Accounts
 * ------------------------------------------------------------------ */

router.get('/chart', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  res.json({
    success: true,
    data: {
      tree: buildAccountTree(store, opts),
      flat: (store.accounts || [])
        .map((a) => ({ ...a, balance: accountBalance(store, a.id, opts) }))
        .sort((a, b) => a.code.localeCompare(b.code))
    }
  });
});

router.post('/chart', (req, res) => {
  try {
    const { name, type, parentId, isGroup, description, openingBalance, openingSide } = req.body;
    if (!name) throw new Error('Account name is required.');

    const account = createAccount(req.tenantStore, { name, type, parentId, isGroup, description });

    if (Number(openingBalance)) {
      posting.postOpeningBalance(req.tenantStore, {
        accountId: account.id,
        amount: openingBalance,
        side: openingSide || (account.type === 'ASSET' || account.type === 'EXPENSE' ? 'DR' : 'CR'),
        createdBy: actor(req)
      });
    }

    res.status(201).json({ success: true, message: 'Ledger account created.', data: account });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/chart/:id', (req, res) => {
  const account = getAccount(req.tenantStore, req.params.id);
  if (!account) return fail(res, new Error('Account not found.'), 404);

  const { name, description, isActive, bankDetails } = req.body;
  if (name) account.name = name;
  if (description !== undefined) account.description = description;
  if (isActive !== undefined) account.isActive = Boolean(isActive);
  if (bankDetails) account.bankDetails = { ...account.bankDetails, ...bankDetails };

  res.json({ success: true, message: 'Account updated.', data: account });
});

router.delete('/chart/:id', (req, res) => {
  const store = req.tenantStore;
  const account = getAccount(store, req.params.id);
  if (!account) return fail(res, new Error('Account not found.'), 404);
  if (account.isSystem) return fail(res, new Error('System accounts cannot be deleted.'));

  const hasPostings = (store.journal || []).some((v) =>
    v.lines.some((l) => l.accountId === account.id)
  );
  if (hasPostings) {
    return fail(res, new Error('Account has journal postings — deactivate it instead of deleting.'));
  }

  store.accounts = store.accounts.filter((a) => a.id !== account.id);
  res.json({ success: true, message: 'Account deleted.' });
});

router.get('/ledger/:accountId', (req, res) => {
  const ledger = accountLedger(req.tenantStore, req.params.accountId, period(req));
  if (!ledger) return fail(res, new Error('Account not found.'), 404);
  res.json({ success: true, data: ledger });
});

/* ------------------------------------------------------------------ *
 * Receivables & payables
 * ------------------------------------------------------------------ */

const partyView = (store, list, type) =>
  list.map((p) => {
    const account = (store.accounts || []).find((a) => a.partyId === p.id && a.partyType === type);
    const balance = account ? accountBalance(store, account.id) : 0;
    return {
      ...p,
      accountId: account ? account.id : null,
      accountCode: account ? account.code : null,
      balance,
      outstanding: type === 'CUSTOMER' ? Math.max(0, balance) : p.outstanding,
      outstandingPayable: type === 'VENDOR' ? Math.max(0, balance) : p.outstandingPayable
    };
  });

router.get('/customers', (req, res) => {
  const store = req.tenantStore;
  const rows = partyView(store, store.customers || [], 'CUSTOMER');
  res.json({
    success: true,
    data: {
      parties: rows,
      totalReceivable: r2(rows.reduce((s, p) => s + Math.max(0, p.balance), 0)),
      totalAdvance: r2(rows.reduce((s, p) => s + Math.min(0, p.balance), 0)),
      ageing: ageing(store, 'CUSTOMER', {})
    }
  });
});

router.get('/vendors', (req, res) => {
  const store = req.tenantStore;
  const rows = partyView(store, store.vendors || [], 'VENDOR');
  res.json({
    success: true,
    data: {
      parties: rows,
      totalPayable: r2(rows.reduce((s, p) => s + Math.max(0, p.balance), 0)),
      totalAdvance: r2(rows.reduce((s, p) => s + Math.min(0, p.balance), 0)),
      ageing: ageing(store, 'VENDOR', {})
    }
  });
});

/* ------------------------------------------------------------------ *
 * Bank & cash accounts
 * ------------------------------------------------------------------ */

const liquidView = (store, systemKey) =>
  (store.accounts || [])
    .filter((a) => a.systemKey === systemKey)
    .map((a) => {
      const ledger = accountLedger(store, a.id, {});
      const last = ledger.entries[ledger.entries.length - 1];
      return {
        ...a,
        balance: ledger.closing,
        totalInflow: ledger.totalDebit,
        totalOutflow: ledger.totalCredit,
        transactionCount: ledger.entries.length,
        lastActivity: last ? last.date : null
      };
    });

router.get('/banks', (req, res) => {
  const rows = liquidView(req.tenantStore, 'BANK');
  res.json({
    success: true,
    data: { accounts: rows, total: r2(rows.reduce((s, a) => s + a.balance, 0)) }
  });
});

router.post('/banks', (req, res) => {
  try {
    const store = req.tenantStore;
    const { name, accountNumber, ifsc, branch, accountType, openingBalance, openingDate } = req.body;
    if (!name) throw new Error('Bank name is required.');

    const parent = bySystemKey(store, 'BANK_GROUP');
    const account = createAccount(store, { name, type: 'ASSET', parentId: parent.id });
    account.systemKey = 'BANK';
    account.bankDetails = {
      accountNumber: accountNumber || '',
      ifsc: ifsc || '',
      branch: branch || '',
      accountType: accountType || 'Current'
    };

    if (Number(openingBalance)) {
      posting.postOpeningBalance(store, {
        accountId: account.id,
        amount: openingBalance,
        side: 'DR',
        date: openingDate,
        createdBy: actor(req)
      });
    }

    res.status(201).json({ success: true, message: 'Bank account created.', data: account });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/cash', (req, res) => {
  const store = req.tenantStore;
  const rows = liquidView(store, 'CASH');
  const today = dayKey(new Date());
  const primary = rows[0];
  const book = primary ? dayBook(store, primary.id, {}) : null;
  const todayRow = book ? book.days.find((d) => d.date === today) : null;

  res.json({
    success: true,
    data: {
      accounts: rows,
      total: r2(rows.reduce((s, a) => s + a.balance, 0)),
      today: todayRow || { date: today, opening: primary ? primary.balance : 0, inflow: 0, outflow: 0, closing: primary ? primary.balance : 0, entries: [] },
      book: book ? book.days.slice(-30).reverse() : []
    }
  });
});

router.post('/cash', (req, res) => {
  try {
    const store = req.tenantStore;
    const { name, openingBalance, openingDate } = req.body;
    if (!name) throw new Error('Cash account name is required.');

    const parent = bySystemKey(store, 'CASH_GROUP');
    const account = createAccount(store, { name, type: 'ASSET', parentId: parent.id });
    account.systemKey = 'CASH';

    if (Number(openingBalance)) {
      posting.postOpeningBalance(store, {
        accountId: account.id,
        amount: openingBalance,
        side: 'DR',
        date: openingDate,
        createdBy: actor(req)
      });
    }

    res.status(201).json({ success: true, message: 'Cash account created.', data: account });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Journal
 * ------------------------------------------------------------------ */

router.get('/journal', (req, res) => {
  const store = req.tenantStore;
  const { type, from, to, q, accountId } = req.query;

  let rows = store.journal || [];
  if (type && type !== 'ALL') rows = rows.filter((v) => v.type === type);
  if (from) rows = rows.filter((v) => dayKey(v.date) >= dayKey(from));
  if (to) rows = rows.filter((v) => dayKey(v.date) <= dayKey(to));
  if (accountId) rows = rows.filter((v) => v.lines.some((l) => l.accountId === accountId));
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (v) =>
        v.voucherNo.toLowerCase().includes(needle) ||
        (v.narration || '').toLowerCase().includes(needle) ||
        v.lines.some((l) => (l.accountName || '').toLowerCase().includes(needle))
    );
  }

  res.json({
    success: true,
    data: {
      vouchers: rows.slice(0, Number(req.query.limit) || 300),
      count: rows.length,
      totalDebit: r2(rows.reduce((s, v) => s + v.totalDebit, 0)),
      types: [...new Set((store.journal || []).map((v) => v.type))]
    }
  });
});

router.post('/journal', (req, res) => {
  try {
    const { date, narration, lines } = req.body;
    const voucher = postJournal(req.tenantStore, {
      type: 'JOURNAL',
      date,
      narration,
      lines,
      isSystem: false,
      createdBy: actor(req)
    });
    res.status(201).json({ success: true, message: `Voucher ${voucher.voucherNo} posted.`, data: voucher });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/journal/:id/reverse', (req, res) => {
  try {
    const voucher = reverseJournal(req.tenantStore, req.params.id, actor(req));
    res.json({ success: true, message: `Reversal ${voucher.voucherNo} posted.`, data: voucher });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Income
 * ------------------------------------------------------------------ */

router.get('/income', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const heads = (store.accounts || []).filter((a) => a.type === 'INCOME' && !a.isGroup);
  res.json({
    success: true,
    data: {
      entries: (store.incomes || []).filter((i) => !opts.from || dayKey(i.date) >= dayKey(opts.from)),
      heads: heads.map((h) => ({ ...h, balance: accountBalance(store, h.id, opts) })),
      total: r2(heads.reduce((s, h) => s + accountBalance(store, h.id, opts), 0))
    }
  });
});

router.post('/income', (req, res) => {
  try {
    const store = req.tenantStore;
    const { accountId, amount, paymentMode, settlementAccountId, notes, date } = req.body;
    if (!Number(amount)) throw new Error('Amount is required.');

    const record = {
      id: `inc_${Date.now()}`,
      accountId,
      amount: r2(amount),
      paymentMode: paymentMode || 'Cash',
      settlementAccountId: settlementAccountId || null,
      notes: notes || '',
      date: date || new Date().toISOString()
    };

    const voucher = posting.postIncome(store, record, { createdBy: actor(req) });
    record.voucherId = voucher.id;
    record.voucherNo = voucher.voucherNo;
    store.incomes.unshift(record);

    res.status(201).json({ success: true, message: `Income recorded (${voucher.voucherNo}).`, data: record });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Expenses
 * ------------------------------------------------------------------ */

router.get('/expenses', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const heads = (store.accounts || []).filter((a) => a.type === 'EXPENSE' && !a.isGroup);
  res.json({
    success: true,
    data: {
      entries: store.expenses || [],
      heads: heads.map((h) => ({ ...h, balance: accountBalance(store, h.id, opts) })),
      total: r2(heads.reduce((s, h) => s + accountBalance(store, h.id, opts), 0))
    }
  });
});

router.post('/expenses', (req, res) => {
  try {
    const store = req.tenantStore;
    const { accountId, amount, tax, paymentMode, settlementAccountId, notes, date, unpaid, vendorId } =
      req.body;
    if (!Number(amount)) throw new Error('Amount is required.');

    const account = resolveAccount(store, accountId);
    const vendor = vendorId ? findVendor(store, vendorId) : null;

    const record = {
      id: `e_${Date.now()}`,
      accountId: account ? account.id : null,
      category: account ? account.name : 'General',
      amount: r2(amount),
      tax: r2(tax),
      paymentMode: paymentMode || 'Cash',
      settlementAccountId: settlementAccountId || null,
      unpaid: Boolean(unpaid),
      vendorId: vendor ? vendor.id : null,
      vendorName: vendor ? vendor.name : null,
      notes: notes || '',
      date: date || new Date().toISOString()
    };

    const voucher = posting.postExpense(store, record, { vendor, createdBy: actor(req) });
    record.voucherId = voucher.id;
    record.voucherNo = voucher.voucherNo;
    store.expenses.unshift(record);

    res.status(201).json({ success: true, message: `Expense booked (${voucher.voucherNo}).`, data: record });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Receipts & payments
 * ------------------------------------------------------------------ */

router.get('/receipts', (req, res) => {
  res.json({ success: true, data: req.tenantStore.receipts || [] });
});

router.post('/receipts', (req, res) => {
  try {
    const store = req.tenantStore;
    const { customerId, amount, discount, paymentMode, settlementAccountId, notes, date, reference } =
      req.body;
    const customer = findCustomer(store, customerId);
    if (!customer) throw new Error('Customer not found.');
    if (!Number(amount)) throw new Error('Receipt amount is required.');

    const record = {
      id: `rcpt_${Date.now()}`,
      customerId: customer.id,
      customerName: customer.name,
      amount: r2(amount),
      discount: r2(discount),
      paymentMode: paymentMode || 'Cash',
      settlementAccountId: settlementAccountId || null,
      reference: reference || '',
      notes: notes || '',
      date: date || new Date().toISOString()
    };

    const voucher = posting.postReceipt(store, record, { customer, createdBy: actor(req) });
    record.voucherId = voucher.id;
    record.voucherNo = voucher.voucherNo;
    store.receipts.unshift(record);

    // Keep the legacy POS field aligned with the ledger.
    const account = (store.accounts || []).find(
      (a) => a.partyId === customer.id && a.partyType === 'CUSTOMER'
    );
    customer.outstanding = Math.max(0, accountBalance(store, account.id));

    res.status(201).json({
      success: true,
      message: `Receipt ${voucher.voucherNo} recorded — ₹${record.amount} from ${customer.name}.`,
      data: record
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/payments', (req, res) => {
  res.json({ success: true, data: req.tenantStore.payments || [] });
});

router.post('/payments', (req, res) => {
  try {
    const store = req.tenantStore;
    const { vendorId, amount, discount, paymentMode, settlementAccountId, notes, date, reference } =
      req.body;
    const vendor = findVendor(store, vendorId);
    if (!vendor) throw new Error('Vendor not found.');
    if (!Number(amount)) throw new Error('Payment amount is required.');

    const record = {
      id: `pay_${Date.now()}`,
      vendorId: vendor.id,
      vendorName: vendor.name,
      amount: r2(amount),
      discount: r2(discount),
      paymentMode: paymentMode || 'Cash',
      settlementAccountId: settlementAccountId || null,
      reference: reference || '',
      notes: notes || '',
      date: date || new Date().toISOString()
    };

    const voucher = posting.postPayment(store, record, { vendor, createdBy: actor(req) });
    record.voucherId = voucher.id;
    record.voucherNo = voucher.voucherNo;
    store.payments.unshift(record);

    const account = (store.accounts || []).find(
      (a) => a.partyId === vendor.id && a.partyType === 'VENDOR'
    );
    vendor.outstandingPayable = Math.max(0, accountBalance(store, account.id));

    res.status(201).json({
      success: true,
      message: `Payment ${voucher.voucherNo} recorded — ₹${record.amount} to ${vendor.name}.`,
      data: record
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Fund transfers
 * ------------------------------------------------------------------ */

router.get('/transfers', (req, res) => {
  const store = req.tenantStore;
  res.json({
    success: true,
    data: {
      transfers: store.transfers || [],
      accounts: liquidAccounts(store).map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        kind: a.systemKey,
        balance: accountBalance(store, a.id)
      }))
    }
  });
});

router.post('/transfers', (req, res) => {
  try {
    const store = req.tenantStore;
    const { fromAccountId, toAccountId, amount, charges, notes, date, reference } = req.body;
    if (!Number(amount)) throw new Error('Transfer amount is required.');

    const record = {
      id: `trf_${Date.now()}`,
      fromAccountId,
      toAccountId,
      fromName: resolveAccount(store, fromAccountId)?.name,
      toName: resolveAccount(store, toAccountId)?.name,
      amount: r2(amount),
      charges: r2(charges),
      reference: reference || '',
      notes: notes || '',
      date: date || new Date().toISOString()
    };

    const voucher = posting.postFundTransfer(store, record, { createdBy: actor(req) });
    record.voucherId = voucher.id;
    record.voucherNo = voucher.voucherNo;
    store.transfers.unshift(record);

    res.status(201).json({ success: true, message: `Transfer ${voucher.voucherNo} posted.`, data: record });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Opening balances
 * ------------------------------------------------------------------ */

router.get('/opening-balances', (req, res) => {
  const store = req.tenantStore;
  const openings = (store.journal || []).filter((v) => v.type === 'OPENING');

  const captured = {};
  openings.forEach((v) => {
    v.lines.forEach((l) => {
      const acc = getAccount(store, l.accountId);
      if (!acc || acc.systemKey === 'OPENING_EQUITY') return;
      if (!captured[l.accountId]) captured[l.accountId] = { debit: 0, credit: 0 };
      captured[l.accountId].debit += l.debit;
      captured[l.accountId].credit += l.credit;
    });
  });

  res.json({
    success: true,
    data: {
      vouchers: openings,
      accounts: (store.accounts || [])
        .filter((a) => !a.isGroup)
        .map((a) => {
          const c = captured[a.id];
          const net = c ? r2(c.debit - c.credit) : 0;
          return {
            id: a.id,
            code: a.code,
            name: a.name,
            type: a.type,
            partyType: a.partyType,
            openingDebit: net > 0 ? net : 0,
            openingCredit: net < 0 ? r2(-net) : 0,
            hasOpening: Boolean(c)
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code)),
      suspenseBalance: accountBalance(store, bySystemKey(store, 'OPENING_EQUITY').id)
    }
  });
});

router.post('/opening-balances', (req, res) => {
  try {
    const store = req.tenantStore;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [req.body];
    const posted = rows
      .filter((r) => Number(r.amount))
      .map((r) =>
        posting.postOpeningBalance(store, {
          accountId: r.accountId,
          amount: r.amount,
          side: r.side,
          date: r.date || req.body.date,
          createdBy: actor(req)
        })
      );

    res.status(201).json({
      success: true,
      message: `${posted.length} opening balance voucher(s) posted.`,
      data: posted
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

router.get('/reconciliation/:accountId', (req, res) => {
  const store = req.tenantStore;
  const ledger = accountLedger(store, req.params.accountId, period(req));
  if (!ledger) return fail(res, new Error('Account not found.'), 404);

  const cleared = new Set(
    (store.reconciliations || [])
      .filter((r) => r.accountId === req.params.accountId)
      .flatMap((r) => r.clearedVoucherIds || [])
  );

  const entries = ledger.entries.map((e) => ({ ...e, cleared: cleared.has(e.voucherId) }));
  const unclearedDebit = r2(entries.filter((e) => !e.cleared).reduce((s, e) => s + e.debit, 0));
  const unclearedCredit = r2(entries.filter((e) => !e.cleared).reduce((s, e) => s + e.credit, 0));

  res.json({
    success: true,
    data: {
      account: ledger.account,
      bookBalance: ledger.closing,
      clearedBalance: r2(ledger.closing - (unclearedDebit - unclearedCredit)),
      unclearedDebit,
      unclearedCredit,
      entries,
      history: (store.reconciliations || []).filter((r) => r.accountId === req.params.accountId)
    }
  });
});

router.post('/reconciliation', (req, res) => {
  const store = req.tenantStore;
  const { accountId, statementBalance, statementDate, clearedVoucherIds, notes } = req.body;

  const ledger = accountLedger(store, accountId, {});
  if (!ledger) return fail(res, new Error('Account not found.'), 404);

  const cleared = new Set(clearedVoucherIds || []);
  const clearedNet = r2(
    ledger.entries
      .filter((e) => cleared.has(e.voucherId))
      .reduce((s, e) => s + e.debit - e.credit, 0)
  );

  const record = {
    id: `rec_${Date.now()}`,
    accountId,
    accountName: ledger.account.name,
    statementBalance: r2(statementBalance),
    statementDate: statementDate || new Date().toISOString(),
    bookBalance: ledger.closing,
    clearedBalance: clearedNet,
    difference: r2(r2(statementBalance) - clearedNet),
    clearedVoucherIds: [...cleared],
    notes: notes || '',
    reconciledBy: actor(req),
    reconciledAt: new Date().toISOString()
  };
  record.status = Math.abs(record.difference) < 0.01 ? 'RECONCILED' : 'DIFFERENCE';

  store.reconciliations.unshift(record);
  res.status(201).json({
    success: true,
    message:
      record.status === 'RECONCILED'
        ? 'Account reconciled — statement matches the books.'
        : `Reconciled with a difference of ₹${record.difference.toFixed(2)}.`,
    data: record
  });
});

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

router.get('/reports/trial-balance', (req, res) => {
  res.json({ success: true, data: trialBalance(req.tenantStore, period(req)) });
});

router.get('/reports/profit-loss', (req, res) => {
  res.json({ success: true, data: profitAndLoss(req.tenantStore, period(req)) });
});

router.get('/reports/balance-sheet', (req, res) => {
  res.json({ success: true, data: balanceSheet(req.tenantStore, { asOf: req.query.asOf || req.query.to }) });
});

router.get('/reports/cash-flow', (req, res) => {
  res.json({ success: true, data: cashFlow(req.tenantStore, period(req)) });
});

router.get('/reports/general-ledger', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const accounts = (store.accounts || [])
    .filter((a) => !a.isGroup)
    .map((a) => accountLedger(store, a.id, opts))
    .filter((l) => l && l.entries.length > 0);

  res.json({
    success: true,
    data: {
      ledgers: accounts.map((l) => ({
        account: { id: l.account.id, code: l.account.code, name: l.account.name, type: l.account.type },
        opening: l.opening,
        closing: l.closing,
        totalDebit: l.totalDebit,
        totalCredit: l.totalCredit,
        entries: l.entries
      }))
    }
  });
});

router.get('/reports/party-ledger/:partyType/:partyId', (req, res) => {
  const store = req.tenantStore;
  const type = req.params.partyType.toUpperCase();
  const account = (store.accounts || []).find(
    (a) => a.partyId === req.params.partyId && a.partyType === type
  );

  // A party with no transactions yet has no sub-ledger — return an empty one
  // rather than a 404, so the drill-down renders "no postings" instead of erroring.
  if (!account) {
    return res.json({
      success: true,
      data: {
        account: null,
        normalSide: type === 'CUSTOMER' ? 'DR' : 'CR',
        opening: 0,
        closing: 0,
        totalDebit: 0,
        totalCredit: 0,
        entries: []
      }
    });
  }

  res.json({ success: true, data: accountLedger(store, account.id, period(req)) });
});

router.get('/reports/day-book/:accountId', (req, res) => {
  const book = dayBook(req.tenantStore, req.params.accountId, period(req));
  if (!book) return fail(res, new Error('Account not found.'), 404);
  res.json({ success: true, data: book });
});

router.get('/reports/outstanding/:partyType', (req, res) => {
  const type = req.params.partyType.toUpperCase();
  res.json({
    success: true,
    data: {
      rows: partyOutstanding(req.tenantStore, type, period(req)),
      ageing: ageing(req.tenantStore, type, { asOf: req.query.to })
    }
  });
});

router.get('/reports/expense', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const section = profitAndLoss(store, opts).expenses;
  res.json({
    success: true,
    data: {
      lines: section.lines,
      total: section.total,
      entries: (store.expenses || []).filter(
        (e) => (!opts.from || dayKey(e.date) >= dayKey(opts.from)) && (!opts.to || dayKey(e.date) <= dayKey(opts.to))
      )
    }
  });
});

router.get('/reports/income', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const section = profitAndLoss(store, opts).income;
  res.json({
    success: true,
    data: {
      lines: section.lines,
      total: section.total,
      entries: (store.incomes || []).filter(
        (e) => (!opts.from || dayKey(e.date) >= dayKey(opts.from)) && (!opts.to || dayKey(e.date) <= dayKey(opts.to))
      )
    }
  });
});

/** GST summary — output tax collected against input credit available. */
router.get('/reports/gst', (req, res) => {
  const store = req.tenantStore;
  const opts = period(req);
  const val = (key) => {
    const acc = bySystemKey(store, key);
    return acc ? Math.abs(accountBalance(store, acc.id, opts)) : 0;
  };

  const output = { cgst: val('CGST_OUTPUT'), sgst: val('SGST_OUTPUT'), igst: val('IGST_OUTPUT') };
  const input = { cgst: val('CGST_INPUT'), sgst: val('SGST_INPUT'), igst: val('IGST_INPUT') };
  const totalOutput = r2(output.cgst + output.sgst + output.igst);
  const totalInput = r2(input.cgst + input.sgst + input.igst);

  res.json({
    success: true,
    data: { output, input, totalOutput, totalInput, netPayable: r2(totalOutput - totalInput) }
  });
});

module.exports = router;
