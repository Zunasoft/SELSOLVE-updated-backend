/**
 * Operational reporting — Module 10 of the SOW.
 * Financial statements live in the Accounts module; these are the shop-floor
 * views: what sold, what moved, what is owed.
 */

const express = require('express');
const engine = require('../accounting/engine');

const router = express.Router();
const r2 = engine.r2;
const dayKey = engine.dayKey;

const liveOrders = (store) => (store.orders || []).filter((o) => o.status !== 'VOID');

function inWindow(date, from, to) {
  const k = dayKey(date);
  if (from && k < dayKey(from)) return false;
  if (to && k > dayKey(to)) return false;
  return true;
}

const windowed = (store, req) =>
  liveOrders(store).filter((o) => inWindow(o.date, req.query.from, req.query.to));

/* ------------------------------- dashboard ------------------------------- */

router.get('/analytics', (req, res) => {
  const store = req.tenantStore;
  const orders = liveOrders(store);
  const today = dayKey(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;

  const todays = orders.filter((o) => dayKey(o.date) === today);
  const monthly = orders.filter((o) => dayKey(o.date) >= monthStart);

  const cash = engine.balanceOf(store, 'CASH');
  const bank = r2(
    (store.accounts || [])
      .filter((a) => a.systemKey === 'BANK')
      .reduce((s, a) => s + engine.accountBalance(store, a.id), 0)
  );

  const lowStock = store.products.filter((p) => p.stock <= (p.minStock ?? 5));

  res.json({
    success: true,
    data: {
      todaysSales: r2(todays.reduce((s, o) => s + o.total, 0)),
      todaysBills: todays.length,
      monthlySales: r2(monthly.reduce((s, o) => s + o.total, 0)),
      monthlyBills: monthly.length,
      averageBillValue: todays.length ? r2(todays.reduce((s, o) => s + o.total, 0) / todays.length) : 0,

      totalSalesCount: orders.length,
      totalRevenue: r2(orders.reduce((s, o) => s + o.total, 0)),
      totalStockItems: r2(store.products.reduce((s, p) => s + p.stock, 0)),
      stockValue: Math.round(store.products.reduce((s, p) => s + p.stock * p.purchasePrice, 0)),
      lowStockCount: lowStock.length,
      lowStockItems: lowStock.slice(0, 10).map((p) => ({ id: p.id, name: p.name, stock: p.stock, minStock: p.minStock, unit: p.unit })),
      totalExpenses: r2((store.expenses || []).reduce((s, e) => s + e.amount, 0)),

      cashInHand: cash,
      bankBalance: bank,
      receivables: r2(engine.partyOutstanding(store, 'CUSTOMER').reduce((s, p) => s + Math.max(0, p.balance), 0)),
      payables: r2(engine.partyOutstanding(store, 'VENDOR').reduce((s, p) => s + Math.max(0, p.balance), 0)),

      recentOrders: orders.slice(0, 8),
      session: store.session
    }
  });
});

/* ------------------------------ sales reports ------------------------------ */

router.get('/reports/sales/daily', (req, res) => {
  const store = req.tenantStore;
  const rows = {};

  windowed(store, req).forEach((o) => {
    const key = dayKey(o.date);
    if (!rows[key]) rows[key] = { date: key, bills: 0, subtotal: 0, discount: 0, tax: 0, total: 0, cogs: 0, modes: {} };
    const row = rows[key];
    row.bills += 1;
    row.subtotal = r2(row.subtotal + o.subtotal);
    row.discount = r2(row.discount + o.discount);
    row.tax = r2(row.tax + o.tax);
    row.total = r2(row.total + o.total);
    row.cogs = r2(row.cogs + (o.cogs || 0));
    row.modes[o.paymentMethod] = r2((row.modes[o.paymentMethod] || 0) + o.total);
  });

  const list = Object.values(rows)
    .map((r) => ({ ...r, grossProfit: r2(r.total - r.tax - r.cogs) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  res.json({
    success: true,
    data: {
      rows: list,
      totals: {
        bills: list.reduce((s, r) => s + r.bills, 0),
        total: r2(list.reduce((s, r) => s + r.total, 0)),
        tax: r2(list.reduce((s, r) => s + r.tax, 0)),
        discount: r2(list.reduce((s, r) => s + r.discount, 0)),
        grossProfit: r2(list.reduce((s, r) => s + r.grossProfit, 0))
      }
    }
  });
});

router.get('/reports/sales/monthly', (req, res) => {
  const store = req.tenantStore;
  const rows = {};

  liveOrders(store).forEach((o) => {
    const key = dayKey(o.date).slice(0, 7);
    if (!rows[key]) rows[key] = { month: key, bills: 0, total: 0, tax: 0, discount: 0, cogs: 0 };
    rows[key].bills += 1;
    rows[key].total = r2(rows[key].total + o.total);
    rows[key].tax = r2(rows[key].tax + o.tax);
    rows[key].discount = r2(rows[key].discount + o.discount);
    rows[key].cogs = r2(rows[key].cogs + (o.cogs || 0));
  });

  res.json({
    success: true,
    data: Object.values(rows)
      .map((r) => ({ ...r, grossProfit: r2(r.total - r.tax - r.cogs) }))
      .sort((a, b) => b.month.localeCompare(a.month))
  });
});

router.get('/reports/sales/products', (req, res) => {
  const store = req.tenantStore;
  const rows = {};

  windowed(store, req).forEach((o) => {
    (o.items || []).forEach((item) => {
      const key = item.id || item.name;
      const product = store.products.find((p) => p.id === item.id || p.name === item.name);
      if (!rows[key]) {
        rows[key] = {
          productId: key,
          name: item.name,
          unit: item.unit || product?.unit || 'pcs',
          qty: 0,
          revenue: 0,
          cost: 0,
          billCount: 0
        };
      }
      const cost = Number(item.purchasePrice ?? product?.purchasePrice ?? 0);
      rows[key].qty = r2(rows[key].qty + Number(item.qty));
      rows[key].revenue = r2(rows[key].revenue + Number(item.total));
      rows[key].cost = r2(rows[key].cost + cost * Number(item.qty));
      rows[key].billCount += 1;
    });
  });

  const list = Object.values(rows)
    .map((r) => ({ ...r, profit: r2(r.revenue - r.cost), margin: r.revenue ? r2(((r.revenue - r.cost) / r.revenue) * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  res.json({ success: true, data: { rows: list, total: r2(list.reduce((s, r) => s + r.revenue, 0)) } });
});

router.get('/reports/sales/categories', (req, res) => {
  const store = req.tenantStore;
  const rows = {};

  windowed(store, req).forEach((o) => {
    (o.items || []).forEach((item) => {
      const product = store.products.find((p) => p.id === item.id || p.name === item.name);
      const category = store.categories.find((c) => c.id === (product?.categoryId || item.categoryId));
      const key = category ? category.id : 'uncategorised';
      if (!rows[key]) {
        rows[key] = { categoryId: key, name: category ? category.name : 'Uncategorised', icon: category?.icon || '📦', qty: 0, revenue: 0, cost: 0 };
      }
      const cost = Number(item.purchasePrice ?? product?.purchasePrice ?? 0);
      rows[key].qty = r2(rows[key].qty + Number(item.qty));
      rows[key].revenue = r2(rows[key].revenue + Number(item.total));
      rows[key].cost = r2(rows[key].cost + cost * Number(item.qty));
    });
  });

  const list = Object.values(rows).sort((a, b) => b.revenue - a.revenue);
  const total = r2(list.reduce((s, r) => s + r.revenue, 0));

  res.json({
    success: true,
    data: {
      rows: list.map((r) => ({ ...r, profit: r2(r.revenue - r.cost), share: total ? r2((r.revenue / total) * 100) : 0 })),
      total
    }
  });
});

router.get('/reports/sales/payment-modes', (req, res) => {
  const store = req.tenantStore;
  const rows = {};

  windowed(store, req).forEach((o) => {
    if (!rows[o.paymentMethod]) rows[o.paymentMethod] = { mode: o.paymentMethod, bills: 0, total: 0 };
    rows[o.paymentMethod].bills += 1;
    rows[o.paymentMethod].total = r2(rows[o.paymentMethod].total + o.total);
  });

  const list = Object.values(rows).sort((a, b) => b.total - a.total);
  const total = r2(list.reduce((s, r) => s + r.total, 0));
  res.json({
    success: true,
    data: { rows: list.map((r) => ({ ...r, share: total ? r2((r.total / total) * 100) : 0 })), total }
  });
});

/* ------------------------------ stock reports ------------------------------ */

router.get('/reports/stock', (req, res) => {
  const store = req.tenantStore;

  const rows = store.products.map((p) => {
    const category = store.categories.find((c) => c.id === p.categoryId);
    const sold = liveOrders(store).reduce(
      (s, o) => s + (o.items || []).filter((i) => i.id === p.id || i.name === p.name).reduce((q, i) => q + Number(i.qty), 0),
      0
    );
    return {
      id: p.id,
      name: p.name,
      category: category ? category.name : '—',
      barcode: p.barcode,
      unit: p.unit,
      stock: p.stock,
      minStock: p.minStock,
      purchasePrice: p.purchasePrice,
      price: p.price,
      valueAtCost: r2(p.stock * p.purchasePrice),
      valueAtRetail: r2(p.stock * p.price),
      sold: r2(sold),
      status: p.stock <= 0 ? 'OUT_OF_STOCK' : p.stock <= (p.minStock ?? 5) ? 'LOW' : 'HEALTHY'
    };
  });

  res.json({
    success: true,
    data: {
      rows: rows.sort((a, b) => a.stock - b.stock),
      totalValueAtCost: r2(rows.reduce((s, r) => s + r.valueAtCost, 0)),
      totalValueAtRetail: r2(rows.reduce((s, r) => s + r.valueAtRetail, 0)),
      lowStock: rows.filter((r) => r.status !== 'HEALTHY').length
    }
  });
});

router.get('/reports/purchases', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.purchases || []).filter((p) => inWindow(p.date, req.query.from, req.query.to));

  const byVendor = {};
  rows.forEach((p) => {
    const key = p.vendorName;
    if (!byVendor[key]) byVendor[key] = { vendor: key, invoices: 0, total: 0, unpaid: 0 };
    byVendor[key].invoices += 1;
    byVendor[key].total = r2(byVendor[key].total + p.totalAmount);
    if (p.paymentStatus !== 'PAID') byVendor[key].unpaid = r2(byVendor[key].unpaid + p.totalAmount);
  });

  res.json({
    success: true,
    data: {
      rows,
      byVendor: Object.values(byVendor).sort((a, b) => b.total - a.total),
      total: r2(rows.reduce((s, p) => s + p.totalAmount, 0)),
      totalTax: r2(rows.reduce((s, p) => s + (p.tax || 0), 0))
    }
  });
});

/* -------------------------- receivables & payables -------------------------- */

/**
 * Customer Outstanding Report — Module 10.
 *
 * Balances come from the party sub-ledgers, never from a stored field, so this
 * can never drift away from what the Accounts module shows.
 */
router.get('/reports/customers/outstanding', (req, res) => {
  const store = req.tenantStore;
  const opts = { from: req.query.from || null, to: req.query.to || null };

  const rows = engine
    .partyOutstanding(store, 'CUSTOMER', opts)
    .map((row) => {
      const customer = (store.customers || []).find((c) => c.id === row.partyId) || {};
      const bills = liveOrders(store).filter((o) => o.customerId === row.partyId);
      const lastBill = bills[0];

      return {
        id: row.partyId,
        name: row.name || customer.name,
        phone: customer.phone || '',
        group: customer.group || 'Retail',
        creditLimit: r2(customer.creditLimit),
        outstanding: r2(Math.max(0, row.balance)),
        advance: r2(Math.max(0, -row.balance)),
        loyaltyPoints: customer.loyaltyPoints || 0,
        billCount: bills.length,
        lastBillDate: lastBill ? lastBill.date : null,
        lastBillAmount: lastBill ? r2(lastBill.total) : 0,
        // A shop wants to know who is past the limit it granted them, not just
        // who owes something.
        overLimit: Number(customer.creditLimit) > 0 && row.balance > Number(customer.creditLimit)
      };
    })
    .filter((row) => row.outstanding > 0 || row.advance > 0)
    .sort((a, b) => b.outstanding - a.outstanding);

  res.json({
    success: true,
    data: {
      rows,
      ageing: engine.ageing(store, 'CUSTOMER', { asOf: req.query.to }),
      totalOutstanding: r2(rows.reduce((s, r) => s + r.outstanding, 0)),
      totalAdvance: r2(rows.reduce((s, r) => s + r.advance, 0)),
      overLimitCount: rows.filter((r) => r.overLimit).length
    }
  });
});

/** Vendor Payables Report — Module 10. */
router.get('/reports/vendors/payables', (req, res) => {
  const store = req.tenantStore;
  const opts = { from: req.query.from || null, to: req.query.to || null };

  const rows = engine
    .partyOutstanding(store, 'VENDOR', opts)
    .map((row) => {
      const vendor = (store.vendors || []).find((v) => v.id === row.partyId) || {};
      const invoices = (store.purchases || []).filter((p) => p.vendorId === row.partyId);
      const lastInvoice = invoices[0];

      return {
        id: row.partyId,
        name: row.name || vendor.name,
        phone: vendor.phone || '',
        gstin: vendor.gstin || '',
        payable: r2(Math.max(0, row.balance)),
        advancePaid: r2(Math.max(0, -row.balance)),
        invoiceCount: invoices.length,
        totalPurchased: r2(invoices.reduce((s, p) => s + p.totalAmount, 0)),
        lastInvoiceDate: lastInvoice ? lastInvoice.date : null,
        lastInvoiceNo: lastInvoice ? lastInvoice.invoiceNo : null
      };
    })
    .filter((row) => row.payable > 0 || row.advancePaid > 0)
    .sort((a, b) => b.payable - a.payable);

  res.json({
    success: true,
    data: {
      rows,
      ageing: engine.ageing(store, 'VENDOR', { asOf: req.query.to }),
      totalPayable: r2(rows.reduce((s, r) => s + r.payable, 0)),
      totalAdvance: r2(rows.reduce((s, r) => s + r.advancePaid, 0))
    }
  });
});

/* ------------------------------ expense report ------------------------------ */

/**
 * Expense Report — Module 9/10. Grouped by expense head, with the individual
 * entries underneath so a total can always be drilled into.
 */
router.get('/reports/expenses', (req, res) => {
  const store = req.tenantStore;
  const opts = { from: req.query.from || null, to: req.query.to || null };

  const entries = (store.expenses || []).filter((e) => inWindow(e.date, opts.from, opts.to));

  const byCategory = {};
  entries.forEach((e) => {
    const key = e.category || 'General';
    if (!byCategory[key]) byCategory[key] = { category: key, accountId: e.accountId, count: 0, amount: 0, tax: 0 };
    byCategory[key].count += 1;
    byCategory[key].amount = r2(byCategory[key].amount + Number(e.amount || 0));
    byCategory[key].tax = r2(byCategory[key].tax + Number(e.tax || 0));
  });

  const byMode = {};
  entries.forEach((e) => {
    const key = e.unpaid ? 'Unpaid (Credit)' : e.paymentMode || 'Cash';
    byMode[key] = r2((byMode[key] || 0) + Number(e.amount || 0));
  });

  const categories = Object.values(byCategory).sort((a, b) => b.amount - a.amount);
  const total = r2(categories.reduce((s, c) => s + c.amount, 0));

  res.json({
    success: true,
    data: {
      rows: categories.map((c) => ({ ...c, share: total ? r2((c.amount / total) * 100) : 0 })),
      entries: entries.sort((a, b) => new Date(b.date) - new Date(a.date)),
      byMode: Object.entries(byMode).map(([mode, amount]) => ({ mode, amount })),
      total,
      totalTax: r2(entries.reduce((s, e) => s + Number(e.tax || 0), 0)),
      unpaid: r2(entries.filter((e) => e.unpaid).reduce((s, e) => s + Number(e.amount || 0), 0)),
      count: entries.length
    }
  });
});

/* --------------------------- cash flow / day summary --------------------------- */

/**
 * Daily Cash Summary — Module 16. Opening, in, out and closing for every day in
 * the window, taken from the cash account's own day book.
 */
router.get('/reports/cash-summary', (req, res) => {
  const store = req.tenantStore;
  const opts = { from: req.query.from || null, to: req.query.to || null };

  const cashAccounts = (store.accounts || []).filter((a) => a.systemKey === 'CASH');
  const bankAccounts = (store.accounts || []).filter((a) => a.systemKey === 'BANK');
  const primaryCash = cashAccounts[0];

  const book = primaryCash ? engine.dayBook(store, primaryCash.id, opts) : null;
  const days = book ? [...book.days].reverse() : [];

  res.json({
    success: true,
    data: {
      days,
      cashBalance: r2(cashAccounts.reduce((s, a) => s + engine.accountBalance(store, a.id), 0)),
      bankBalance: r2(bankAccounts.reduce((s, a) => s + engine.accountBalance(store, a.id), 0)),
      accounts: [...cashAccounts, ...bankAccounts].map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.systemKey,
        balance: r2(engine.accountBalance(store, a.id))
      })),
      totalInflow: r2(days.reduce((s, d) => s + d.inflow, 0)),
      totalOutflow: r2(days.reduce((s, d) => s + d.outflow, 0)),
      session: store.session
    }
  });
});

/* ----------------------------- session reports ----------------------------- */

router.get('/reports/sessions', (req, res) => {
  const store = req.tenantStore;
  const history = [...(store.sessions || [])];
  if (store.session && store.session.status === 'open') history.unshift(store.session);

  res.json({
    success: true,
    data: history.map((s) => ({
      ...s,
      cashIn: r2((s.cashEntries || []).filter((e) => e.type === 'IN').reduce((sum, e) => sum + e.amount, 0)),
      cashOut: r2((s.cashEntries || []).filter((e) => e.type === 'OUT').reduce((sum, e) => sum + e.amount, 0))
    }))
  });
});

/* ------------------------------ export payload ------------------------------ */

const EXPORTABLE = {
  'sales-daily': { title: 'Daily Sales Report', path: '/reports/sales/daily' },
  'sales-monthly': { title: 'Monthly Sales Report', path: '/reports/sales/monthly' },
  'sales-products': { title: 'Product Sales Report', path: '/reports/sales/products' },
  'sales-categories': { title: 'Category Sales Report', path: '/reports/sales/categories' },
  stock: { title: 'Stock Report', path: '/reports/stock' },
  purchases: { title: 'Purchase Report', path: '/reports/purchases' },
  'customer-outstanding': { title: 'Customer Outstanding Report', path: '/reports/customers/outstanding' },
  'vendor-payables': { title: 'Vendor Payables Report', path: '/reports/vendors/payables' },
  expenses: { title: 'Expense Report', path: '/reports/expenses' },
  'cash-summary': { title: 'Daily Cash Summary', path: '/reports/cash-summary' }
};

/**
 * Flat, column-typed rows for the client-side PDF and Excel exporters — the
 * server owns the report definition so both formats stay in step.
 */
router.get('/reports/export/:report', (req, res) => {
  const store = req.tenantStore;
  const key = req.params.report;
  const meta = EXPORTABLE[key];
  if (!meta) return res.status(404).json({ success: false, message: 'Unknown report.' });

  const shapes = {
    'sales-daily': () => {
      const rows = {};
      windowed(store, req).forEach((o) => {
        const k = dayKey(o.date);
        if (!rows[k]) rows[k] = { Date: k, Bills: 0, Subtotal: 0, Discount: 0, GST: 0, Total: 0 };
        rows[k].Bills += 1;
        rows[k].Subtotal = r2(rows[k].Subtotal + o.subtotal);
        rows[k].Discount = r2(rows[k].Discount + o.discount);
        rows[k].GST = r2(rows[k].GST + o.tax);
        rows[k].Total = r2(rows[k].Total + o.total);
      });
      return Object.values(rows).sort((a, b) => b.Date.localeCompare(a.Date));
    },
    'sales-monthly': () => {
      const rows = {};
      liveOrders(store).forEach((o) => {
        const k = dayKey(o.date).slice(0, 7);
        if (!rows[k]) rows[k] = { Month: k, Bills: 0, GST: 0, Total: 0 };
        rows[k].Bills += 1;
        rows[k].GST = r2(rows[k].GST + o.tax);
        rows[k].Total = r2(rows[k].Total + o.total);
      });
      return Object.values(rows).sort((a, b) => b.Month.localeCompare(a.Month));
    },
    'sales-products': () => {
      const rows = {};
      windowed(store, req).forEach((o) =>
        (o.items || []).forEach((i) => {
          const k = i.name;
          if (!rows[k]) rows[k] = { Product: k, Unit: i.unit || 'pcs', Quantity: 0, Revenue: 0 };
          rows[k].Quantity = r2(rows[k].Quantity + Number(i.qty));
          rows[k].Revenue = r2(rows[k].Revenue + Number(i.total));
        })
      );
      return Object.values(rows).sort((a, b) => b.Revenue - a.Revenue);
    },
    'sales-categories': () => {
      const rows = {};
      windowed(store, req).forEach((o) =>
        (o.items || []).forEach((i) => {
          const product = store.products.find((p) => p.id === i.id || p.name === i.name);
          const category = store.categories.find((c) => c.id === product?.categoryId);
          const k = category ? category.name : 'Uncategorised';
          if (!rows[k]) rows[k] = { Category: k, Quantity: 0, Revenue: 0 };
          rows[k].Quantity = r2(rows[k].Quantity + Number(i.qty));
          rows[k].Revenue = r2(rows[k].Revenue + Number(i.total));
        })
      );
      return Object.values(rows).sort((a, b) => b.Revenue - a.Revenue);
    },
    stock: () =>
      store.products.map((p) => ({
        Product: p.name,
        Barcode: p.barcode,
        Unit: p.unit,
        Stock: p.stock,
        'Min Stock': p.minStock,
        'Cost Price': p.purchasePrice,
        'Selling Price': p.price,
        'Stock Value': r2(p.stock * p.purchasePrice)
      })),
    purchases: () =>
      (store.purchases || [])
        .filter((p) => inWindow(p.date, req.query.from, req.query.to))
        .map((p) => ({
          Date: dayKey(p.date),
          Invoice: p.invoiceNo,
          Vendor: p.vendorName,
          Taxable: p.subtotal,
          GST: p.tax,
          Total: p.totalAmount,
          Status: p.paymentStatus
        })),
    'customer-outstanding': () =>
      engine
        .partyOutstanding(store, 'CUSTOMER', { to: req.query.to })
        .filter((row) => row.balance > 0)
        .map((row) => {
          const customer = (store.customers || []).find((c) => c.id === row.partyId) || {};
          return {
            Customer: row.name,
            Phone: customer.phone || '—',
            Group: customer.group || 'Retail',
            'Credit Limit': r2(customer.creditLimit),
            Outstanding: r2(row.balance),
            'Last Activity': row.lastActivity ? dayKey(row.lastActivity) : '—'
          };
        }),
    'vendor-payables': () =>
      engine
        .partyOutstanding(store, 'VENDOR', { to: req.query.to })
        .filter((row) => row.balance > 0)
        .map((row) => {
          const vendor = (store.vendors || []).find((v) => v.id === row.partyId) || {};
          return {
            Vendor: row.name,
            Phone: vendor.phone || '—',
            GSTIN: vendor.gstin || '—',
            Payable: r2(row.balance),
            'Last Activity': row.lastActivity ? dayKey(row.lastActivity) : '—'
          };
        }),
    expenses: () =>
      (store.expenses || [])
        .filter((e) => inWindow(e.date, req.query.from, req.query.to))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map((e) => ({
          Date: dayKey(e.date),
          Category: e.category || 'General',
          Vendor: e.vendorName || '—',
          Amount: r2(e.amount),
          GST: r2(e.tax),
          'Paid By': e.unpaid ? 'Unpaid (Credit)' : e.paymentMode || 'Cash',
          Voucher: e.voucherNo || '—',
          Notes: e.notes || ''
        })),
    'cash-summary': () => {
      const cash = (store.accounts || []).find((a) => a.systemKey === 'CASH');
      if (!cash) return [];
      const book = engine.dayBook(store, cash.id, { from: req.query.from, to: req.query.to });
      return [...(book ? book.days : [])].reverse().map((d) => ({
        Date: d.date,
        Opening: r2(d.opening),
        'Cash In': r2(d.inflow),
        'Cash Out': r2(d.outflow),
        Closing: r2(d.closing),
        Entries: d.entries.length
      }));
    }
  };

  const rows = shapes[key]();

  res.json({
    success: true,
    data: {
      title: meta.title,
      company: store.settings.company,
      period: { from: req.query.from || null, to: req.query.to || null },
      generatedAt: new Date().toISOString(),
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows
    }
  });
});

router.get('/reports/catalog', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(EXPORTABLE).map(([key, v]) => ({ key, ...v }))
  });
});

module.exports = router;
