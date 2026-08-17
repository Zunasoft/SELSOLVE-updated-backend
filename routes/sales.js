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

/**
 * Everything the terminal needs to boot. The store was already loaded from the
 * tenant's own database by `resolveTenantDb`, so this reads straight from it.
 */
router.get('/init', (req, res) => {
  const store = req.tenantStore;

  res.json({
    success: true,
    tenantDb: req.tenantDbName,
    shop: req.tenant ? { name: req.tenant.name, email: req.tenant.email, plan: req.tenant.plan } : undefined,
    data: {
      categories: store.categories || [],
      products: store.products || [],
      session: store.session,
      customers: store.customers || [],
      vendors: store.vendors || [],
      heldBills: store.heldBills || [],
      tables: store.tables || [],
      settings: store.settings,
      priceSheets: store.priceSheets || [],
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
 * A line billed in an alternate unit still moves base units of stock: one "box"
 * of a product whose box factor is 12 takes 12 pieces off the shelf. The factor
 * travels on the cart line, so a bill printed in boxes and a stock report
 * counted in pieces stay in agreement.
 */
function baseQty(product, cartItem) {
  const qty = Number(cartItem.qty) || 0;
  const soldUnit = String(cartItem.saleUnit || cartItem.unit || '').toLowerCase().trim();
  const prodUnit = String(product?.unit || '').toLowerCase().trim();

  if (!soldUnit || !prodUnit || soldUnit === prodUnit) return qty;

  // 1. Explicit unitFactor passed on the cart item (e.g. 0.001 for grams when base is kg)
  if (Number(cartItem.unitFactor) > 0) {
    return qty * Number(cartItem.unitFactor);
  }

  // 2. Look up in product's altUnits
  const alt = (product.altUnits || []).find(
    (u) => String(u.unit).toLowerCase() === soldUnit
  );
  if (alt && Number(alt.factor) > 0) {
    return qty * Number(alt.factor);
  }

  // 3. Look up in product's customSubUnit
  const subName = String(product.customSubUnitName || '').toLowerCase().trim();
  const subFactor = Number(product.customSubUnitFactor) || 0;
  if (subName && subName === soldUnit && subFactor > 0) {
    return qty / subFactor; // e.g. 500 g with subFactor 1000 => 500 / 1000 = 0.5 kg
  }

  // 4. Standard conversions fallback
  if (prodUnit === 'kg' && (soldUnit === 'g' || soldUnit === 'gm' || soldUnit === 'grams')) {
    return qty / 1000;
  }
  if ((prodUnit === 'g' || prodUnit === 'gm') && soldUnit === 'kg') {
    return qty * 1000;
  }
  if ((prodUnit === 'ltr' || prodUnit === 'liter' || prodUnit === 'litre') && (soldUnit === 'ml' || soldUnit === 'milliliter')) {
    return qty / 1000;
  }
  if (prodUnit === 'dozen' && soldUnit === 'pcs') {
    return qty / (subFactor || 12);
  }
  if ((prodUnit === 'box' || prodUnit === 'carton') && soldUnit === 'pcs') {
    return qty / (subFactor || 12);
  }

  return qty;
}

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

    const soldQty = baseQty(product, cartItem);
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId);
        if (!raw) return;
        const reqPerUnit = Number(ing.qty) || 0;
        const deducted = Math.round(reqPerUnit * soldQty * 10000) / 10000;

        if (raw.stock < deducted) {
          shortages.push({ name: raw.name, available: raw.stock });
        }

        raw.stock = Math.max(0, Math.round((Number(raw.stock || 0) - deducted) * 10000) / 10000);
        if (raw.warehouses) {
          raw.warehouses['wh_shop'] = Math.max(0, Math.round((Number(raw.warehouses['wh_shop'] || 0) - deducted) * 10000) / 10000);
          raw.stock = Object.values(raw.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: raw,
          type: 'SALE',
          qtyChange: -deducted,
          reason: `Consumed in ${product.name} (Sold on ${orderId})`,
          refId: orderId,
          user
        });
      });
      return;
    }

    const isCombo = product.isCombo || product.productType === 'combo';
    const comboItems = product.comboItems || product.bundleItems || [];
    if (isCombo && comboItems.length > 0) {
      comboItems.forEach((ci) => {
        const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
        if (!comp) return;
        const compQty = Number(ci.qty || ci.quantity || 1);
        const deducted = Math.round(compQty * soldQty * 10000) / 10000;

        if (comp.stock < deducted) {
          shortages.push({ name: comp.name, available: comp.stock });
        }

        comp.stock = Math.max(0, Math.round((Number(comp.stock || 0) - deducted) * 10000) / 10000);
        if (comp.warehouses) {
          comp.warehouses['wh_shop'] = Math.max(0, Math.round((Number(comp.warehouses['wh_shop'] || 0) - deducted) * 10000) / 10000);
          comp.stock = Object.values(comp.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: comp,
          type: 'SALE',
          qtyChange: -deducted,
          reason: `Bundled in combo ${product.name} (Sold on ${orderId})`,
          refId: orderId,
          user
        });
      });
      return;
    }

    if (product.stock < soldQty) {
      shortages.push({ name: product.name, available: product.stock });
    }

    product.stock = r2(product.stock - soldQty);
    if (product.warehouses) {
      product.warehouses['wh_shop'] = (product.warehouses['wh_shop'] || 0) - soldQty;
      product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
    }

    logStockMovement(store, {
      product,
      type: 'SALE',
      qtyChange: -soldQty,
      reason: `Sold on ${orderId}`,
      refId: orderId,
      user
    });
  });

  return shortages;
}

router.post('/orders', async (req, res) => {
  const store = req.tenantStore;
  const {
    customerName, customerPhone, customerId, paymentMethod,
    subtotal, tax, discount, total, items, tableId, splitPayments, notes,
    redeemPoints
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

  /* ----------------------------- loyalty redemption -----------------------------
   * Points come off the bill before it is posted, so the ledger, the drawer and
   * the printed receipt all agree on what the customer actually paid.
   */
  const pos = store.settings.pos || {};
  let loyaltyRedeemed = 0;
  let pointsRedeemed = 0;

  if (customer && Number(redeemPoints) > 0) {
    if (pos.enableLoyalty === false) {
      return res.status(400).json({ success: false, message: 'Loyalty points are switched off for this shop.' });
    }

    const available = customer.loyaltyPoints || 0;
    const wanted = Math.floor(Number(redeemPoints));
    const minPoints = Number(pos.loyaltyMinRedeemPoints) || 0;

    if (wanted > available) {
      return res.status(400).json({
        success: false,
        message: `${customer.name} has only ${available} point(s) available.`
      });
    }
    if (wanted < minPoints) {
      return res.status(400).json({
        success: false,
        message: `At least ${minPoints} points are needed before they can be redeemed.`
      });
    }

    const rate = Number(pos.loyaltyRedeemValue) || 0;
    // Redemption can settle a bill but never turn it into a refund.
    loyaltyRedeemed = Math.min(r2(wanted * rate), r2(total));
    pointsRedeemed = rate > 0 ? Math.ceil(loyaltyRedeemed / rate) : 0;
    customer.loyaltyPoints = available - pointsRedeemed;
  }

  const payableTotal = r2(Number(total) - loyaltyRedeemed);

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
    loyaltyRedeemed,
    pointsRedeemed,
    grossTotal: r2(total),
    total: payableTotal,
    notes: notes || '',
    tableId: tableId || null,
    cashier: actor(req),
    sessionId: store.session?.id || null,
    date: new Date().toISOString(),
    status: 'COMPLETED',
    items
  };

  // Points accrue on what was actually paid, not on the value settled with
  // points — otherwise redeeming would keep topping the balance back up.
  if (customer && pos.enableLoyalty !== false) {
    const earned = Math.floor((order.total / 100) * (pos.loyaltyPointsPerHundred || 1));
    customer.loyaltyPoints = (customer.loyaltyPoints || 0) + earned;
    order.loyaltyEarned = earned;
    order.loyaltyBalance = customer.loyaltyPoints;
  }

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

  // The invoice, the stock it moved and the vouchers it posted are all part of
  // this tenant's store, which the tenant middleware flushes to the tenant's own
  // database before this response is sent.
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

    const soldQty = baseQty(product, item);
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId);
        if (!raw) return;
        const reqPerUnit = Number(ing.qty) || 0;
        const returned = Math.round(reqPerUnit * soldQty * 10000) / 10000;
        raw.stock = Math.round((Number(raw.stock || 0) + returned) * 10000) / 10000;
        
        if (raw.warehouses) {
          raw.warehouses['wh_shop'] = Math.round((Number(raw.warehouses['wh_shop'] || 0) + returned) * 10000) / 10000;
          raw.stock = Object.values(raw.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: raw,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Void of ${order.orderId} (Restored from ${product.name})`,
          refId: order.orderId,
          user: actor(req)
        });
      });
      return;
    }

    const isCombo = product.isCombo || product.productType === 'combo';
    const comboItems = product.comboItems || product.bundleItems || [];
    if (isCombo && comboItems.length > 0) {
      comboItems.forEach((ci) => {
        const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
        if (!comp) return;
        const compQty = Number(ci.qty || ci.quantity || 1);
        const returned = Math.round(compQty * soldQty * 10000) / 10000;
        comp.stock = Math.round((Number(comp.stock || 0) + returned) * 10000) / 10000;

        if (comp.warehouses) {
          comp.warehouses['wh_shop'] = Math.round((Number(comp.warehouses['wh_shop'] || 0) + returned) * 10000) / 10000;
          comp.stock = Object.values(comp.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
        }

        logStockMovement(store, {
          product: comp,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Void of ${order.orderId} (Restored from combo ${product.name})`,
          refId: order.orderId,
          user: actor(req)
        });
      });
      return;
    }

    product.stock = r2(product.stock + soldQty);
    if (product.warehouses) {
      product.warehouses['wh_shop'] = (product.warehouses['wh_shop'] || 0) + soldQty;
      product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);
    }

    logStockMovement(store, {
      product,
      type: 'RETURN',
      qtyChange: soldQty,
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

  // Unwind loyalty in both directions: take back what the bill earned and give
  // back what it consumed, so a void leaves the customer exactly where they were.
  const customer = (store.customers || []).find((c) => c.id === order.customerId);
  if (customer) {
    const balance = (customer.loyaltyPoints || 0) - (order.loyaltyEarned || 0) + (order.pointsRedeemed || 0);
    customer.loyaltyPoints = Math.max(0, balance);
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
  const denominations = req.body.denominations || null;
  let openingCash = Number(req.body.openingCash) || 0;

  if (denominations && typeof denominations === 'object') {
    const dTotal =
      (Number(denominations['2000'] || 0) * 2000) +
      (Number(denominations['500'] || 0) * 500) +
      (Number(denominations['200'] || 0) * 200) +
      (Number(denominations['100'] || 0) * 100) +
      (Number(denominations['50'] || 0) * 50) +
      (Number(denominations['20'] || 0) * 20) +
      (Number(denominations['10'] || 0) * 10) +
      (Number(denominations['coins'] || 0));
    if (dTotal > 0 || openingCash === 0) {
      openingCash = dTotal;
    }
  }

  store.session = {
    id: `sess_${Date.now()}`,
    status: 'open',
    openedAt: new Date().toISOString(),
    openedBy: req.body.user || actor(req),
    openingCash: r2(openingCash),
    currentCash: r2(openingCash),
    openingDenominations: denominations,
    cashEntries: []
  };

  res.json({ success: true, message: 'POS counter session opened.', data: store.session });
});

router.post('/session/close', (req, res) => {
  const store = req.tenantStore;
  if (!store.session || store.session.status === 'closed') {
    return res.status(400).json({ success: false, message: 'No open session to close.' });
  }

  const denominations = req.body.closingDenominations || req.body.denominations || null;
  let countedCash = req.body.countedCash !== undefined ? Number(req.body.countedCash) : store.session.currentCash;

  if (denominations && typeof denominations === 'object') {
    const dTotal =
      (Number(denominations['2000'] || 0) * 2000) +
      (Number(denominations['500'] || 0) * 500) +
      (Number(denominations['200'] || 0) * 200) +
      (Number(denominations['100'] || 0) * 100) +
      (Number(denominations['50'] || 0) * 50) +
      (Number(denominations['20'] || 0) * 20) +
      (Number(denominations['10'] || 0) * 10) +
      (Number(denominations['coins'] || 0));
    countedCash = dTotal;
  }

  const sessionOrders = (store.orders || []).filter((o) => o.sessionId === store.session.id && o.status !== 'VOID');

  Object.assign(store.session, {
    status: 'closed',
    closedAt: new Date().toISOString(),
    closedBy: req.body.user || actor(req),
    countedCash: r2(countedCash),
    closingDenominations: denominations,
    expectedCash: r2(store.session.currentCash),
    variance: r2(countedCash - store.session.currentCash),
    billCount: sessionOrders.length,
    salesTotal: r2(sessionOrders.reduce((s, o) => s + (o.total || 0), 0)),
    notes: req.body.notes || ''
  });

  store.sessions.unshift({ ...store.session });

  res.json({ success: true, message: 'POS counter session closed.', data: store.session });
});

router.post('/session/cash-entry', (req, res) => {
  const store = req.tenantStore;
  const { type, amount, reason, person, purpose, classification, expenseCategory, accountId, vendorId } = req.body;
  const value = Number(amount);
  if (!value) return res.status(400).json({ success: false, message: 'Amount is required.' });
  if (!store.session || store.session.status !== 'open') {
    return res.status(400).json({ success: false, message: 'Open a counter session first.' });
  }

  const isUnofficial = classification === 'UNOFFICIAL';
  const isExpense = classification === 'EXPENSE' || type === 'EXPENSE';
  const isVendorRepay = classification === 'VENDOR_REPAY' || Boolean(vendorId);
  const effectiveType = isExpense ? 'OUT' : (type === 'IN' ? 'IN' : 'OUT');

  store.session.currentCash = r2(
    effectiveType === 'IN'
      ? store.session.currentCash + value
      : store.session.currentCash - value
  );

  let vendorObj = null;
  if (isVendorRepay) {
    vendorObj = (store.vendors || []).find((v) => v.id === vendorId || (v.name && person && v.name.toLowerCase() === person.toLowerCase())) || null;
  }

  const entry = {
    id: `ce_${Date.now()}`,
    type: effectiveType,
    amount: value,
    classification: isExpense ? 'EXPENSE' : isVendorRepay ? 'VENDOR_REPAY' : isUnofficial ? 'UNOFFICIAL' : 'OFFICIAL',
    person: (vendorObj ? vendorObj.name : person) || '',
    vendorId: vendorObj ? vendorObj.id : null,
    purpose: purpose || reason || (isExpense ? 'Internal business expense' : isVendorRepay ? 'Vendor Debt Repayment / Refund' : `Cash ${effectiveType}`),
    expenseCategory: expenseCategory || (isExpense ? 'General' : null),
    reason: reason || purpose || `Cash ${effectiveType}`,
    time: new Date().toISOString(),
    user: actor(req)
  };

  store.session.cashEntries.push(entry);

  let voucherNo = null;
  // Official fund transfers, vendor repayments, or expenses post to double-entry ledger
  if (!isUnofficial) {
    try {
      const cash = engine.bySystemKey(store, 'CASH');
      if (isVendorRepay && vendorObj) {
        const voucher = posting.postVendorRefund(store, {
          amount: value,
          vendor: vendorObj,
          notes: `${entry.purpose} (Vendor: ${vendorObj.name})`,
          createdBy: actor(req)
        });
        voucherNo = voucher.voucherNo;
      } else if (isExpense) {
        const expenseAcc = (store.accounts || []).find((a) => a.type === 'EXPENSE') || { id: 'acc_gen_expense' };
        const voucher = posting.postDirectExpense(
          store,
          {
            id: `exp_${Date.now()}`,
            accountId: expenseAcc.id,
            paidFromAccountId: cash.id,
            amount: value,
            taxAmount: 0,
            notes: `${expenseCategory ? `[${expenseCategory}] ` : ''}${entry.purpose} (Recipient: ${person || 'N/A'})`,
            date: new Date().toISOString()
          },
          { createdBy: actor(req) }
        );
        voucherNo = voucher.voucherNo;
      } else {
        const bank = (store.accounts || []).find((a) => a.systemKey === 'BANK');
        const counter = accountId ? engine.resolveAccount(store, accountId) : bank;
        if (counter && counter.id !== cash.id) {
          const voucher = posting.postFundTransfer(
            store,
            {
              id: `cashentry_${Date.now()}`,
              fromAccountId: effectiveType === 'IN' ? counter.id : cash.id,
              toAccountId: effectiveType === 'IN' ? cash.id : counter.id,
              amount: value,
              charges: 0,
              notes: `${entry.purpose}${person ? ` (Person: ${person})` : ''}`,
              date: new Date().toISOString()
            },
            { createdBy: actor(req) }
          );
          voucherNo = voucher.voucherNo;
        }
      }
    } catch (err) {
      /* the drawer entry still stands even if double-entry posting fails */
    }
  }

  res.json({
    success: true,
    message: `${entry.classification === 'EXPENSE' ? 'Expense' : isUnofficial ? 'Unofficial cash' : 'Cash'} ${effectiveType} recorded.`,
    data: { session: store.session, entry, voucherNo }
  });
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
