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
  purchases: { title: 'Purchase Report', path: '/reports/purchases' }
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
        }))
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
