/**
 * Double-entry accounting engine.
 *
 * Every financial event in Selsolve — a POS sale, a purchase invoice, an
 * expense, a receipt, a fund transfer, an opening balance — becomes a balanced
 * journal voucher here. Nothing mutates an account balance directly; balances
 * are always derived from the journal, which keeps the books auditable and
 * makes every report reproducible from the same source of truth.
 */

const { NORMAL_SIDE, buildChartOfAccounts, accountId } = require('./coa');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const VOUCHER_PREFIX = {
  OPENING: 'OB',
  JOURNAL: 'JV',
  SALES: 'SV',
  SALES_RETURN: 'SR',
  PURCHASE: 'PV',
  PURCHASE_RETURN: 'PR',
  RECEIPT: 'RV',
  PAYMENT: 'PMT',
  CONTRA: 'CV',
  EXPENSE: 'EXP',
  INCOME: 'INC',
  STOCK: 'STK'
};

/* ------------------------------------------------------------------ *
 * Store bootstrap
 * ------------------------------------------------------------------ */

/** Attach accounting collections to a tenant store (idempotent). */
function ensureAccounting(store) {
  if (!store.accounts || store.accounts.length === 0) {
    store.accounts = buildChartOfAccounts();
  }
  if (!Array.isArray(store.journal)) store.journal = [];
  if (!store.voucherCounters) store.voucherCounters = {};
  if (!Array.isArray(store.reconciliations)) store.reconciliations = [];
  return store;
}

function nextVoucherNo(store, type) {
  const prefix = VOUCHER_PREFIX[type] || 'JV';
  store.voucherCounters[prefix] = (store.voucherCounters[prefix] || 0) + 1;
  return `${prefix}-${String(store.voucherCounters[prefix]).padStart(5, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Account lookup helpers
 * ------------------------------------------------------------------ */

const getAccount = (store, id) => (store.accounts || []).find((a) => a.id === id) || null;

const bySystemKey = (store, key) => (store.accounts || []).find((a) => a.systemKey === key) || null;

/** Resolve either an account id or a systemKey to a concrete account. */
function resolveAccount(store, ref) {
  if (!ref) return null;
  return getAccount(store, ref) || bySystemKey(store, ref);
}

/** All descendant ids of an account, inclusive of the account itself. */
function accountTreeIds(store, id) {
  const out = [id];
  const walk = (parentId) => {
    (store.accounts || [])
      .filter((a) => a.parentId === parentId)
      .forEach((child) => {
        out.push(child.id);
        walk(child.id);
      });
  };
  walk(id);
  return out;
}

/**
 * Party sub-ledgers live under Accounts Receivable / Accounts Payable so that
 * every customer and vendor has a real ledger account, not just a number on a
 * row. Created on demand the first time a party is transacted with.
 */
function ensurePartyAccount(store, party, partyType) {
  ensureAccounting(store);
  const existing = (store.accounts || []).find(
    (a) => a.partyId === party.id && a.partyType === partyType
  );
  if (existing) {
    if (existing.name !== party.name) existing.name = party.name;
    return existing;
  }

  const isCustomer = partyType === 'CUSTOMER';
  const parent = bySystemKey(store, isCustomer ? 'AR' : 'AP');
  const siblings = (store.accounts || []).filter((a) => a.parentId === parent.id);
  const seq = String(siblings.length + 1).padStart(3, '0');

  const account = {
    id: `acc_${isCustomer ? 'ar' : 'ap'}_${party.id}`,
    code: `${parent.code}-${seq}`,
    name: party.name,
    type: isCustomer ? 'ASSET' : 'LIABILITY',
    isGroup: false,
    parentId: parent.id,
    systemKey: null,
    partyId: party.id,
    partyType,
    isSystem: false,
    isActive: true,
    description: party.phone ? `Contact: ${party.phone}` : '',
    bankDetails: null,
    createdAt: new Date().toISOString()
  };

  store.accounts.push(account);
  return account;
}

/** Create a user-defined ledger under an existing parent. */
function createAccount(store, payload) {
  ensureAccounting(store);
  const parent = payload.parentId ? getAccount(store, payload.parentId) : null;
  const type = payload.type || (parent ? parent.type : 'EXPENSE');

  const siblings = (store.accounts || []).filter((a) => a.parentId === (parent ? parent.id : null));
  const base = parent ? parent.code : String((Number(type === 'ASSET' ? 1 : 2) || 9) * 1000);
  const code = payload.code || `${base}-${String(siblings.length + 1).padStart(3, '0')}`;

  const account = {
    id: `acc_u_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    code,
    name: payload.name,
    type,
    isGroup: Boolean(payload.isGroup),
    parentId: parent ? parent.id : null,
    systemKey: null,
    partyId: null,
    partyType: null,
    isSystem: false,
    isActive: true,
    description: payload.description || '',
    bankDetails: payload.bankDetails || null,
    createdAt: new Date().toISOString()
  };

  store.accounts.push(account);
  return account;
}

/* ------------------------------------------------------------------ *
 * Journal posting
 * ------------------------------------------------------------------ */

/**
 * Post a balanced voucher. Lines with a zero net effect are dropped so callers
 * can pass optional legs (GST, discount, rounding) without pre-filtering.
 * Throws when debits and credits disagree — an unbalanced book is never worth
 * saving, so the caller must fix the entry rather than silently absorb it.
 */
function postJournal(store, entry) {
  ensureAccounting(store);

  const lines = (entry.lines || [])
    .map((l) => {
      const account = resolveAccount(store, l.accountId || l.account);
      return {
        accountId: account ? account.id : null,
        accountCode: account ? account.code : null,
        accountName: account ? account.name : 'Unknown Account',
        debit: r2(l.debit),
        credit: r2(l.credit),
        partyId: l.partyId || (account ? account.partyId : null) || null,
        narration: l.narration || ''
      };
    })
    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0));

  if (lines.length < 2) {
    throw new Error('A journal voucher needs at least two ledger lines.');
  }

  const unknownGroup = lines.find((l) => {
    const acc = getAccount(store, l.accountId);
    return acc && acc.isGroup;
  });
  if (unknownGroup) {
    throw new Error(`Cannot post directly to group account "${unknownGroup.accountName}".`);
  }

  const totalDebit = r2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = r2(lines.reduce((s, l) => s + l.credit, 0));

  if (Math.abs(totalDebit - totalCredit) > 0.009) {
    throw new Error(
      `Voucher is out of balance: debit ₹${totalDebit.toFixed(2)} vs credit ₹${totalCredit.toFixed(2)}.`
    );
  }

  const type = entry.type || 'JOURNAL';
  const voucher = {
    id: `je_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    voucherNo: entry.voucherNo || nextVoucherNo(store, type),
    type,
    date: entry.date || new Date().toISOString(),
    narration: entry.narration || '',
    refType: entry.refType || null,
    refId: entry.refId || null,
    partyId: entry.partyId || null,
    paymentMode: entry.paymentMode || null,
    lines,
    totalDebit,
    totalCredit,
    isSystem: entry.isSystem !== false,
    isReversed: false,
    reversalOf: entry.reversalOf || null,
    createdBy: entry.createdBy || 'system',
    createdAt: new Date().toISOString()
  };

  store.journal.unshift(voucher);
  return voucher;
}

/** Cancel a voucher by posting its mirror image — the audit trail stays intact. */
function reverseJournal(store, voucherId, createdBy) {
  const original = (store.journal || []).find((j) => j.id === voucherId);
  if (!original) throw new Error('Voucher not found.');
  if (original.isReversed) throw new Error('Voucher has already been reversed.');

  const reversal = postJournal(store, {
    type: original.type,
    date: new Date().toISOString(),
    narration: `Reversal of ${original.voucherNo} — ${original.narration}`,
    refType: original.refType,
    refId: original.refId,
    partyId: original.partyId,
    reversalOf: original.id,
    createdBy: createdBy || 'system',
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      narration: l.narration
    }))
  });

  original.isReversed = true;
  original.reversedBy = reversal.id;
  return reversal;
}

/* ------------------------------------------------------------------ *
 * Balances & ledgers
 * ------------------------------------------------------------------ */

const dayKey = (d) => {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d).slice(0, 10);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch (_) {
    return String(d).slice(0, 10);
  }
};

function inRange(date, from, to) {
  const k = dayKey(date);
  if (from && k < dayKey(from)) return false;
  if (to && k > dayKey(to)) return false;
  return true;
}

/** Raw debit/credit movement per account over a period. */
function accountMovements(store, { from, to } = {}) {
  const map = {};
  (store.journal || []).forEach((v) => {
    if (!inRange(v.date, from, to)) return;
    v.lines.forEach((l) => {
      if (!map[l.accountId]) map[l.accountId] = { debit: 0, credit: 0 };
      map[l.accountId].debit += l.debit;
      map[l.accountId].credit += l.credit;
    });
  });
  Object.keys(map).forEach((k) => {
    map[k].debit = r2(map[k].debit);
    map[k].credit = r2(map[k].credit);
  });
  return map;
}

/**
 * Signed balance in the account's own natural direction: positive means the
 * account sits on its normal side (a customer who owes you, cash you hold).
 * Rolls up children so group accounts report a meaningful total.
 */
function accountBalance(store, id, { from, to } = {}) {
  const account = getAccount(store, id);
  if (!account) return 0;
  const ids = new Set(accountTreeIds(store, id));
  let debit = 0;
  let credit = 0;

  (store.journal || []).forEach((v) => {
    if (!inRange(v.date, from, to)) return;
    v.lines.forEach((l) => {
      if (!ids.has(l.accountId)) return;
      debit += l.debit;
      credit += l.credit;
    });
  });

  return NORMAL_SIDE[account.type] === 'DR' ? r2(debit - credit) : r2(credit - debit);
}

const balanceOf = (store, systemKey, opts) => {
  const acc = bySystemKey(store, systemKey);
  return acc ? accountBalance(store, acc.id, opts) : 0;
};

/** Running ledger for one account, oldest first, with an opening carry-forward. */
function accountLedger(store, id, { from, to } = {}) {
  const account = getAccount(store, id);
  if (!account) return null;
  const ids = new Set(accountTreeIds(store, id));
  const isDebitNormal = NORMAL_SIDE[account.type] === 'DR';

  const rows = [];
  let opening = 0;

  const sorted = [...(store.journal || [])].sort((a, b) => new Date(a.date) - new Date(b.date));

  sorted.forEach((v) => {
    v.lines.forEach((l) => {
      if (!ids.has(l.accountId)) return;
      const signed = isDebitNormal ? l.debit - l.credit : l.credit - l.debit;

      if (from && dayKey(v.date) < dayKey(from)) {
        opening += signed;
        return;
      }
      if (to && dayKey(v.date) > dayKey(to)) return;

      rows.push({
        voucherId: v.id,
        voucherNo: v.voucherNo,
        type: v.type,
        date: v.date,
        narration: l.narration || v.narration,
        accountId: l.accountId,
        accountName: l.accountName,
        debit: l.debit,
        credit: l.credit,
        isReversed: v.isReversed
      });
    });
  });

  let running = r2(opening);
  const entries = rows.map((row) => {
    running = r2(running + (isDebitNormal ? row.debit - row.credit : row.credit - row.debit));
    return { ...row, balance: running };
  });

  return {
    account,
    normalSide: isDebitNormal ? 'DR' : 'CR',
    opening: r2(opening),
    closing: running,
    totalDebit: r2(entries.reduce((s, e) => s + e.debit, 0)),
    totalCredit: r2(entries.reduce((s, e) => s + e.credit, 0)),
    entries
  };
}

/* ------------------------------------------------------------------ *
 * Financial statements
 * ------------------------------------------------------------------ */

/** Trial balance across every posting account, with a balanced-books check. */
function trialBalance(store, { from, to } = {}) {
  const movements = accountMovements(store, { from, to });

  const rows = (store.accounts || [])
    .filter((a) => !a.isGroup)
    .map((a) => {
      const m = movements[a.id] || { debit: 0, credit: 0 };
      const net = r2(m.debit - m.credit);
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? r2(-net) : 0,
        movementDebit: m.debit,
        movementCredit: m.credit
      };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(rows.reduce((s, r) => s + r.credit, 0));

  return {
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    difference: r2(totalDebit - totalCredit)
  };
}

function statementSection(store, type, { from, to } = {}) {
  const movements = accountMovements(store, { from, to });
  const normal = NORMAL_SIDE[type];

  const lines = (store.accounts || [])
    .filter((a) => a.type === type && !a.isGroup)
    .map((a) => {
      const m = movements[a.id] || { debit: 0, credit: 0 };
      const amount = normal === 'DR' ? r2(m.debit - m.credit) : r2(m.credit - m.debit);
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        parentId: a.parentId,
        amount
      };
    })
    .filter((l) => l.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  return { lines, total: r2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/** Profit & Loss for a period. Gross profit isolates COGS from opex. */
function profitAndLoss(store, { from, to } = {}) {
  const income = statementSection(store, 'INCOME', { from, to });
  const expenses = statementSection(store, 'EXPENSE', { from, to });

  const cogsAcc = bySystemKey(store, 'COGS');
  const cogs = cogsAcc ? Math.abs(accountBalance(store, cogsAcc.id, { from, to })) : 0;

  const salesAcc = bySystemKey(store, 'SALES');
  const revenue = salesAcc ? accountBalance(store, salesAcc.id, { from, to }) : 0;

  const grossProfit = r2(revenue - cogs);
  const operatingExpenses = r2(expenses.total - cogs);
  const netProfit = r2(income.total - expenses.total);

  return {
    from: from || null,
    to: to || null,
    income,
    expenses,
    revenue: r2(revenue),
    cogs: r2(cogs),
    grossProfit,
    grossMargin: revenue ? r2((grossProfit / revenue) * 100) : 0,
    operatingExpenses,
    totalIncome: income.total,
    totalExpenses: expenses.total,
    netProfit,
    netMargin: income.total ? r2((netProfit / income.total) * 100) : 0
  };
}

/**
 * Balance Sheet as at a date. Current-period profit is folded into equity so
 * the statement balances without requiring a year-end closing entry.
 */
function balanceSheet(store, { asOf } = {}) {
  const to = asOf || new Date().toISOString();

  const assets = statementSection(store, 'ASSET', { to });
  const liabilities = statementSection(store, 'LIABILITY', { to });
  const equity = statementSection(store, 'EQUITY', { to });

  const pl = profitAndLoss(store, { to });
  const currentEarnings = pl.netProfit;

  const equityLines = [
    ...equity.lines,
    {
      accountId: 'computed_current_earnings',
      code: '3250',
      name: 'Current Period Earnings',
      parentId: null,
      amount: currentEarnings
    }
  ].filter((l) => l.amount !== 0);

  const totalAssets = assets.total;
  const totalEquity = r2(equity.total + currentEarnings);
  const totalLiabilities = liabilities.total;

  return {
    asOf: to,
    assets,
    liabilities,
    equity: { lines: equityLines, total: totalEquity },
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: r2(totalLiabilities + totalEquity),
    isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    difference: r2(totalAssets - (totalLiabilities + totalEquity))
  };
}

const liquidAccounts = (store) =>
  (store.accounts || []).filter(
    (a) => !a.isGroup && (a.systemKey === 'CASH' || a.systemKey === 'BANK' || a.isLiquid)
  );

/**
 * Cash Flow — direct method. Every voucher touching a cash or bank ledger is
 * classified by the counter-leg it faces, which keeps the statement honest
 * without asking the user to tag anything.
 */
function cashFlow(store, { from, to } = {}) {
  const liquidIds = new Set(liquidAccounts(store).map((a) => a.id));

  const buckets = {
    operating: { inflow: 0, outflow: 0, items: {} },
    investing: { inflow: 0, outflow: 0, items: {} },
    financing: { inflow: 0, outflow: 0, items: {} }
  };

  const classify = (account) => {
    if (!account) return 'operating';
    if (account.type === 'EQUITY' || account.systemKey === 'LOANS') return 'financing';
    const isFixedAsset = (accountTreeIds(store, accountId('1200')) || []).includes(account.id);
    if (isFixedAsset) return 'investing';
    if (account.type === 'LIABILITY' && account.parentId === accountId('2200')) return 'financing';
    return 'operating';
  };

  let opening = 0;
  let closing = 0;

  (store.journal || []).forEach((v) => {
    const cashLines = v.lines.filter((l) => liquidIds.has(l.accountId));
    if (cashLines.length === 0) return;

    const net = r2(cashLines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (net === 0) return;

    if (from && dayKey(v.date) < dayKey(from)) {
      opening = r2(opening + net);
      closing = r2(closing + net);
      return;
    }
    if (to && dayKey(v.date) > dayKey(to)) return;

    closing = r2(closing + net);

    // Attribute the movement to the largest non-cash counter-leg.
    const counter = v.lines
      .filter((l) => !liquidIds.has(l.accountId))
      .sort((a, b) => b.debit + b.credit - (a.debit + a.credit))[0];

    const counterAccount = counter ? getAccount(store, counter.accountId) : null;
    const bucket = buckets[classify(counterAccount)];
    const label = counterAccount ? counterAccount.name : v.type;

    if (!bucket.items[label]) bucket.items[label] = 0;
    bucket.items[label] = r2(bucket.items[label] + net);

    if (net > 0) bucket.inflow = r2(bucket.inflow + net);
    else bucket.outflow = r2(bucket.outflow - net);
  });

  const shape = (b) => ({
    inflow: b.inflow,
    outflow: b.outflow,
    net: r2(b.inflow - b.outflow),
    items: Object.entries(b.items)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b2) => Math.abs(b2.amount) - Math.abs(a.amount))
  });

  const operating = shape(buckets.operating);
  const investing = shape(buckets.investing);
  const financing = shape(buckets.financing);

  return {
    from: from || null,
    to: to || null,
    openingBalance: opening,
    closingBalance: closing,
    operating,
    investing,
    financing,
    netChange: r2(operating.net + investing.net + financing.net)
  };
}

/** Outstanding receivables / payables straight from the party sub-ledgers. */
function partyOutstanding(store, partyType, { to } = {}) {
  return (store.accounts || [])
    .filter((a) => a.partyType === partyType)
    .map((a) => {
      const balance = accountBalance(store, a.id, { to });
      const ledger = accountLedger(store, a.id, { to });
      const last = ledger.entries[ledger.entries.length - 1];
      return {
        accountId: a.id,
        partyId: a.partyId,
        code: a.code,
        name: a.name,
        balance,
        lastActivity: last ? last.date : null,
        entryCount: ledger.entries.length
      };
    })
    .filter((p) => Math.abs(p.balance) > 0.009)
    .sort((a, b) => b.balance - a.balance);
}

/** Ageing buckets for receivables/payables — 0-30 / 31-60 / 61-90 / 90+. */
function ageing(store, partyType, { asOf } = {}) {
  const ref = asOf ? new Date(asOf) : new Date();
  const buckets = ['current', 'd30', 'd60', 'd90', 'older'];

  return (store.accounts || [])
    .filter((a) => a.partyType === partyType)
    .map((a) => {
      const ledger = accountLedger(store, a.id, { to: asOf });
      const row = { accountId: a.id, partyId: a.partyId, name: a.name, total: ledger.closing };
      buckets.forEach((b) => {
        row[b] = 0;
      });

      // Walk invoices newest-first and consume them against the closing balance.
      let remaining = ledger.closing;
      const invoices = [...ledger.entries]
        .filter((e) => (partyType === 'CUSTOMER' ? e.debit > 0 : e.credit > 0))
        .sort((x, y) => new Date(y.date) - new Date(x.date));

      invoices.forEach((inv) => {
        if (remaining <= 0) return;
        const amt = Math.min(remaining, partyType === 'CUSTOMER' ? inv.debit : inv.credit);
        const days = Math.floor((ref - new Date(inv.date)) / 86400000);
        const bucket = days <= 30 ? 'current' : days <= 60 ? 'd30' : days <= 90 ? 'd60' : days <= 120 ? 'd90' : 'older';
        row[bucket] = r2(row[bucket] + amt);
        remaining = r2(remaining - amt);
      });

      return row;
    })
    .filter((r) => Math.abs(r.total) > 0.009)
    .sort((a, b) => b.total - a.total);
}

/** Day-by-day cash book / bank book for a single liquid account. */
function dayBook(store, accountRef, { from, to } = {}) {
  const account = resolveAccount(store, accountRef);
  if (!account) return null;
  const ledger = accountLedger(store, account.id, { from, to });

  const days = {};
  ledger.entries.forEach((e) => {
    const k = dayKey(e.date);
    if (!days[k]) days[k] = { date: k, inflow: 0, outflow: 0, entries: [] };
    days[k].inflow = r2(days[k].inflow + e.debit);
    days[k].outflow = r2(days[k].outflow + e.credit);
    days[k].entries.push(e);
  });

  let running = ledger.opening;
  const rows = Object.values(days)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const openingCash = running;
      running = r2(running + d.inflow - d.outflow);
      return { ...d, opening: openingCash, closing: running };
    });

  return { account, opening: ledger.opening, closing: ledger.closing, days: rows };
}

module.exports = {
  r2,
  ensureAccounting,
  nextVoucherNo,
  getAccount,
  bySystemKey,
  resolveAccount,
  accountTreeIds,
  ensurePartyAccount,
  createAccount,
  postJournal,
  reverseJournal,
  accountMovements,
  accountBalance,
  balanceOf,
  accountLedger,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  cashFlow,
  partyOutstanding,
  ageing,
  dayBook,
  liquidAccounts,
  dayKey,
  inRange
};
