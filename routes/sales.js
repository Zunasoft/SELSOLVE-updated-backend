/**
 * Billing, held bills, counter sessions and table management —
 * Modules 3, 17, 18 and 19 of the SOW.
 */

const express = require('express');
const { logStockMovement } = require('../store');
const engine = require('../accounting/engine');
const posting = require('../accounting/posting');

const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';
const r2 = engine.r2;

/* --------------------------------- init --------------------------------- */

router.get('/init', (req, res) => {
  const store = req.tenantStore;
  res.json({
    success: true,
    tenantDb: req.tenantDbName,
    data: {
      categories: store.categories,
      products: store.products,
      session: store.session,
      customers: store.customers,
      heldBills: store.heldBills || [],
      tables: store.tables || [],
      settings: store.settings,
      users: (store.users || []).map(({ pin, ...u }) => u)
    }
  });
});

/* ------------------------------- held bills ------------------------------- */

router.get('/bills/held', (req, res) => {
  res.json({ success: true, data: req.tenantStore.heldBills || [] });
});

router.post('/bills/hold', (req, res) => {
  const store = req.tenantStore;
  const { customerName, customerId, items, total, notes, tableId } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cannot hold an empty cart.' });
  }

  const heldBill = {
    id: `hb_${Date.now()}`,
    customerName: customerName || 'Walk-in Customer',
    customerId: customerId || null,
    items,
    total: Number(total),
    notes: notes || 'Hold Bill',
    tableId: tableId || null,
    heldBy: actor(req),
    heldAt: new Date().toISOString()
  };

  store.heldBills.unshift(heldBill);

  if (tableId) {
    const table = (store.tables || []).find((t) => t.id === tableId);
    if (table) {
      table.status = 'OCCUPIED';
      table.currentBillId = heldBill.id;
      table.occupiedAt = heldBill.heldAt;
    }
  }

  res.status(201).json({ success: true, message: 'Bill held successfully.', data: heldBill });
});

router.delete('/bills/held/:id', (req, res) => {
  const store = req.tenantStore;
  const bill = (store.heldBills || []).find((h) => h.id === req.params.id);
  store.heldBills = (store.heldBills || []).filter((h) => h.id !== req.params.id);

  if (bill && bill.tableId) {
    const table = (store.tables || []).find((t) => t.id === bill.tableId);
    if (table) Object.assign(table, { status: 'FREE', currentBillId: null, occupiedAt: null });
  }

  res.json({ success: true, message: 'Held bill resumed/cleared.' });
});

/* -------------------------------- checkout -------------------------------- */

/**
 * Deduct sold quantities. A composite product consumes its recipe ingredients
 * instead of its own (notional) stock, which is what keeps raw-material
 * inventory honest for bakeries and kitchens.
 */
function deductStock(store, items, orderId, user) {
  const shortages = [];

  items.forEach((cartItem) => {
    const product = store.products.find((p) => p.id === cartItem.id || p.name === cartItem.name);
    if (!product) return;

    const recipe = (store.recipes || []).find((r) => r.productId === product.id);

    if (product.isComposite && recipe) {
      recipe.ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId);
        if (!raw) return;
        const consumed = (Number(ing.qty) * Number(cartItem.qty)) / (recipe.yieldQty || 1);
        raw.stock = r2(raw.stock - consumed);
        if (raw.stock < 0 && !store.settings.pos.allowNegativeStock) raw.stock = 0;

        if (raw.warehouses) {
          raw.warehouses['wh_shop'] = (raw.warehouses['wh_shop'] || 0) - consumed;
          if (raw.warehouses['wh_shop'] < 0 && !store.settings.pos.allowNegativeStock) {
            raw.warehouses['wh_shop'] = 0;
          }
          raw.stock = Object.values(raw.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: raw,
          type: 'RECIPE',
          qtyChange: -consumed,
          reason: `Consumed for ${product.name}`,
          refId: orderId,
          user
        });
      });
      return;
    }

    const qty = Number(cartItem.qty);
    if (qty > product.stock && !store.settings.pos.allowNegativeStock) {
      shortages.push({ name: product.name, available: product.stock, requested: qty });
    }
    product.stock = store.settings.pos.allowNegativeStock
      ? r2(product.stock - qty)
      : Math.max(0, r2(product.stock - qty));

    if (product.warehouses) {
      product.warehouses['wh_shop'] = (product.warehouses['wh_shop'] || 0) - qty;
      if (product.warehouses['wh_shop'] < 0 && !store.settings.pos.allowNegativeStock) {
        product.warehouses['wh_shop'] = 0;
      }
      product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
    }

    logStockMovement(store, {
      product,
      type: 'SALE',
      qtyChange: -qty,
      reason: `Sold on ${orderId}`,
      refId: orderId,
      user
    });
  });

  return shortages;
}

router.post('/orders', (req, res) => {
  const store = req.tenantStore;
  const {
    customerName, customerPhone, customerId, paymentMethod,
    subtotal, tax, discount, total, items, tableId, splitPayments, notes
  } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty.' });
  }

  const billing = store.settings.billing;
  const orderId = `${billing.invoicePrefix || 'INV'}-${new Date().getFullYear()}-${String(billing.nextInvoiceNo || 1).padStart(4, '0')}`;
  billing.nextInvoiceNo = (billing.nextInvoiceNo || 1) + 1;

  // Resolve or create the customer record for credit sales and loyalty.
  let customer = null;
  if (customerId) customer = store.customers.find((c) => c.id === customerId);
  if (!customer && customerName && customerName !== 'Walk-in Customer') {
    customer = store.customers.find((c) => c.name.toLowerCase() === customerName.toLowerCase());
    if (!customer && posting.isCreditSale(paymentMethod)) {
      customer = {
        id: `c_${Date.now()}`,
        name: customerName,
        phone: customerPhone || 'N/A',
        email: '',
        address: '',
        group: 'Retail',
        creditLimit: 0,
        outstanding: 0,
        loyaltyPoints: 0,
        createdAt: new Date().toISOString()
      };
      store.customers.push(customer);
    }
  }

  if (posting.isCreditSale(paymentMethod) && !customer) {
    return res.status(400).json({
      success: false,
      message: 'A named customer is required for a credit (udhar) sale.'
    });
  }

  const shortages = deductStock(store, items, orderId, actor(req));

  const order = {
    orderId,
    customerId: customer ? customer.id : null,
    customerName: customer ? customer.name : customerName || 'Walk-in Customer',
    customerPhone: customer ? customer.phone : customerPhone || 'N/A',
    paymentMethod: paymentMethod || 'Cash',
    splitPayments: Array.isArray(splitPayments) ? splitPayments : null,
    subtotal: r2(subtotal),
    tax: r2(tax),
    discount: r2(discount),
    total: r2(total),
    notes: notes || '',
    tableId: tableId || null,
    cashier: actor(req),
    sessionId: store.session?.id || null,
    date: new Date().toISOString(),
    status: 'COMPLETED',
    items
  };

  // Loyalty accrues on every non-credit sale.
  if (customer && store.settings.pos.enableLoyalty) {
    const earned = Math.floor((order.total / 100) * (store.settings.pos.loyaltyPointsPerHundred || 1));
    customer.loyaltyPoints = (customer.loyaltyPoints || 0) + earned;
    order.loyaltyEarned = earned;
  }

  // Cash sales move the counter drawer.
  if (String(paymentMethod).toLowerCase() === 'cash' && store.session) {
    store.session.currentCash = r2(store.session.currentCash + order.total);
    store.session.cashEntries.push({
      type: 'IN',
      amount: order.total,
      reason: `Sale ${orderId}`,
      time: order.date
    });
  }

  // Double-entry posting — the single source of truth for the accounts module.
  let accounting = null;
  try {
    accounting = posting.postSale(store, order, {
      customer,
      interState: store.settings.tax.interState,
      createdBy: actor(req)
    });
    order.voucherNo = accounting.voucher.voucherNo;
    order.voucherId = accounting.voucher.id;
    order.cogs = accounting.cogsAmount;
  } catch (err) {
    order.accountingError = err.message;
  }

  if (customer) {
    const account = (store.accounts || []).find(
      (a) => a.partyId === customer.id && a.partyType === 'CUSTOMER'
    );
    if (account) customer.outstanding = Math.max(0, engine.accountBalance(store, account.id));
  }

  store.orders.unshift(order);

  if (tableId) {
    const table = (store.tables || []).find((t) => t.id === tableId);
    if (table) Object.assign(table, { status: 'FREE', currentBillId: null, occupiedAt: null });
  }

  res.status(201).json({
    success: true,
    message: 'Sale checkout completed successfully.',
    warnings: shortages.length ? shortages.map((s) => `${s.name}: only ${s.available} left`) : [],
    data: { ...order, company: store.settings.company, billing: store.settings.billing }
  });
});

router.get('/orders', (req, res) => {
  const store = req.tenantStore;
  const { from, to, q, paymentMethod, limit } = req.query;

  let rows = store.orders;
  if (from) rows = rows.filter((o) => engine.dayKey(o.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((o) => engine.dayKey(o.date) <= engine.dayKey(to));
  if (paymentMethod && paymentMethod !== 'ALL') rows = rows.filter((o) => o.paymentMethod === paymentMethod);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (o) => o.orderId.toLowerCase().includes(needle) || (o.customerName || '').toLowerCase().includes(needle)
    );
  }

  res.json({ success: true, data: rows.slice(0, Number(limit) || 200), count: rows.length });
});

router.get('/orders/:orderId', (req, res) => {
  const store = req.tenantStore;
  const order = store.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  res.json({ success: true, data: { ...order, company: store.settings.company, billing: store.settings.billing } });
});

/** Void a completed bill: restore stock and reverse every related voucher. */
router.post('/orders/:orderId/void', (req, res) => {
  const store = req.tenantStore;
  const order = store.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (order.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Invoice is already voided.' });
  }

  order.items.forEach((item) => {
    const product = store.products.find((p) => p.id === item.id || p.name === item.name);
    if (!product) return;

    const recipe = (store.recipes || []).find((r) => r.productId === product.id);

    if (product.isComposite && recipe) {
      recipe.ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId);
        if (!raw) return;
        const returned = (Number(ing.qty) * Number(item.qty)) / (recipe.yieldQty || 1);
        raw.stock = r2(raw.stock + returned);
        
        if (raw.warehouses) {
          raw.warehouses['wh_shop'] = (raw.warehouses['wh_shop'] || 0) + returned;
          raw.stock = Object.values(raw.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: raw,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Void of ${order.orderId}`,
          refId: order.orderId,
          user: actor(req)
        });
      });
      return;
    }

    product.stock = r2(product.stock + Number(item.qty));
    if (product.warehouses) {
      product.warehouses['wh_shop'] = (product.warehouses['wh_shop'] || 0) + Number(item.qty);
      product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
    }

    logStockMovement(store, {
      product,
      type: 'RETURN',
      qtyChange: Number(item.qty),
      reason: `Void of ${order.orderId}`,
      refId: order.orderId,
      user: actor(req)
    });
  });

  const reversed = [];
  (store.journal || [])
    .filter((v) => v.refId === order.orderId && !v.isReversed && !v.reversalOf)
    .forEach((v) => {
      try {
        reversed.push(engine.reverseJournal(store, v.id, actor(req)).voucherNo);
      } catch (err) {
        /* already reversed — nothing to undo */
      }
    });

  if (order.paymentMethod === 'Cash' && store.session) {
    store.session.currentCash = r2(store.session.currentCash - order.total);
    store.session.cashEntries.push({
      type: 'OUT',
      amount: order.total,
      reason: `Void ${order.orderId}`,
      time: new Date().toISOString()
    });
  }

  order.status = 'VOID';
  order.voidedBy = actor(req);
  order.voidedAt = new Date().toISOString();

  res.json({ success: true, message: `Invoice ${order.orderId} voided.`, data: { order, reversed } });
});

/* --------------------------------- session --------------------------------- */

router.get('/session', (req, res) => {
  res.json({ success: true, data: req.tenantStore.session });
});

router.get('/sessions', (req, res) => {
  res.json({ success: true, data: req.tenantStore.sessions || [] });
});

router.post('/session/open', (req, res) => {
  const store = req.tenantStore;
  const openingCash = Number(req.body.openingCash) || 0;

  store.session = {
    id: `sess_${Date.now()}`,
    status: 'open',
    openedAt: new Date().toISOString(),
    openedBy: req.body.user || actor(req),
    openingCash,
    currentCash: openingCash,
    cashEntries: []
  };

  res.json({ success: true, message: 'POS counter session opened.', data: store.session });
});

router.post('/session/close', (req, res) => {
  const store = req.tenantStore;
  if (!store.session || store.session.status === 'closed') {
    return res.status(400).json({ success: false, message: 'No open session to close.' });
  }

  const countedCash = req.body.countedCash !== undefined ? Number(req.body.countedCash) : store.session.currentCash;
  const sessionOrders = store.orders.filter((o) => o.sessionId === store.session.id && o.status !== 'VOID');

  Object.assign(store.session, {
    status: 'closed',
    closedAt: new Date().toISOString(),
    closedBy: req.body.user || actor(req),
    countedCash,
    expectedCash: store.session.currentCash,
    variance: r2(countedCash - store.session.currentCash),
    billCount: sessionOrders.length,
    salesTotal: r2(sessionOrders.reduce((s, o) => s + o.total, 0)),
    notes: req.body.notes || ''
  });

  store.sessions.unshift({ ...store.session });

  res.json({ success: true, message: 'POS counter session closed.', data: store.session });
});

router.post('/session/cash-entry', (req, res) => {
  const store = req.tenantStore;
  const { type, amount, reason, accountId } = req.body;
  const value = Number(amount);
  if (!value) return res.status(400).json({ success: false, message: 'Amount is required.' });
  if (!store.session || store.session.status !== 'open') {
    return res.status(400).json({ success: false, message: 'Open a counter session first.' });
  }

  store.session.currentCash = r2(type === 'IN' ? store.session.currentCash + value : store.session.currentCash - value);
  store.session.cashEntries.push({
    type,
    amount: value,
    reason: reason || 'Cash adjustment',
    time: new Date().toISOString(),
    user: actor(req)
  });

  // Cash moved in or out of the drawer is a real fund transfer, so it posts.
  let voucherNo = null;
  try {
    const cash = engine.bySystemKey(store, 'CASH');
    const bank = (store.accounts || []).find((a) => a.systemKey === 'BANK');
    const counter = accountId ? engine.resolveAccount(store, accountId) : bank;

    if (counter && counter.id !== cash.id) {
      const voucher = posting.postFundTransfer(
        store,
        {
          id: `cashentry_${Date.now()}`,
          fromAccountId: type === 'IN' ? counter.id : cash.id,
          toAccountId: type === 'IN' ? cash.id : counter.id,
          amount: value,
          charges: 0,
          notes: reason || `Counter cash ${type}`,
          date: new Date().toISOString()
        },
        { createdBy: actor(req) }
      );
      voucherNo = voucher.voucherNo;
    }
  } catch (err) {
    /* the drawer entry still stands even if the contra could not be posted */
  }

  res.json({ success: true, message: `Cash ${type} entry recorded.`, data: { session: store.session, voucherNo } });
});

/* --------------------------------- tables --------------------------------- */

router.get('/tables', (req, res) => {
  const store = req.tenantStore;
  res.json({
    success: true,
    data: (store.tables || []).map((t) => ({
      ...t,
      bill: (store.heldBills || []).find((h) => h.id === t.currentBillId) || null
    }))
  });
});

router.post('/tables', (req, res) => {
  const { name, area, seats } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Table name is required.' });
  const table = {
    id: `tbl_${Date.now()}`,
    name,
    area: area || 'Main',
    seats: Number(seats) || 4,
    status: 'FREE',
    currentBillId: null,
    occupiedAt: null
  };
  req.tenantStore.tables.push(table);
  res.status(201).json({ success: true, data: table });
});

router.put('/tables/:id', (req, res) => {
  const table = (req.tenantStore.tables || []).find((t) => t.id === req.params.id);
  if (!table) return res.status(404).json({ success: false, message: 'Table not found.' });
  Object.assign(table, req.body, { id: table.id });
  res.json({ success: true, data: table });
});

router.delete('/tables/:id', (req, res) => {
  const store = req.tenantStore;
  const table = (store.tables || []).find((t) => t.id === req.params.id);
  if (table && table.status === 'OCCUPIED') {
    return res.status(400).json({ success: false, message: 'Cannot delete an occupied table.' });
  }
  store.tables = (store.tables || []).filter((t) => t.id !== req.params.id);
  res.json({ success: true, message: 'Table removed.' });
});

/** Move a running bill from one table to another. */
router.post('/tables/transfer', (req, res) => {
  const store = req.tenantStore;
  const { fromTableId, toTableId } = req.body;
  const from = (store.tables || []).find((t) => t.id === fromTableId);
  const to = (store.tables || []).find((t) => t.id === toTableId);

  if (!from || !to) return res.status(404).json({ success: false, message: 'Table not found.' });
  if (to.status === 'OCCUPIED') {
    return res.status(400).json({ success: false, message: `${to.name} is already occupied — merge instead.` });
  }

  const bill = (store.heldBills || []).find((h) => h.id === from.currentBillId);
  if (bill) bill.tableId = to.id;

  Object.assign(to, { status: from.status, currentBillId: from.currentBillId, occupiedAt: from.occupiedAt });
  Object.assign(from, { status: 'FREE', currentBillId: null, occupiedAt: null });

  res.json({ success: true, message: `Bill transferred from ${from.name} to ${to.name}.`, data: { from, to } });
});

/** Merge two running tables into a single bill. */
router.post('/tables/merge', (req, res) => {
  const store = req.tenantStore;
  const { sourceTableId, targetTableId } = req.body;
  const source = (store.tables || []).find((t) => t.id === sourceTableId);
  const target = (store.tables || []).find((t) => t.id === targetTableId);

  if (!source || !target) return res.status(404).json({ success: false, message: 'Table not found.' });

  const sourceBill = (store.heldBills || []).find((h) => h.id === source.currentBillId);
  const targetBill = (store.heldBills || []).find((h) => h.id === target.currentBillId);

  if (!sourceBill || !targetBill) {
    return res.status(400).json({ success: false, message: 'Both tables must have a running bill to merge.' });
  }

  sourceBill.items.forEach((item) => {
    const existing = targetBill.items.find((i) => i.id === item.id);
    if (existing) {
      existing.qty = r2(existing.qty + item.qty);
      existing.total = r2(existing.qty * existing.price);
    } else {
      targetBill.items.push(item);
    }
  });
  targetBill.total = r2(targetBill.items.reduce((s, i) => s + i.total, 0));
  targetBill.notes = `${targetBill.notes} · merged ${source.name}`;

  store.heldBills = store.heldBills.filter((h) => h.id !== sourceBill.id);
  Object.assign(source, { status: 'FREE', currentBillId: null, occupiedAt: null });

  res.json({ success: true, message: `${source.name} merged into ${target.name}.`, data: targetBill });
});

module.exports = router;
