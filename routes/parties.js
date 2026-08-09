/**
 * Customers, vendors and purchase management — Modules 6, 7 and 8 of the SOW.
 * Outstanding balances shown here are read straight from the party sub-ledgers
 * so they can never disagree with the Accounts module.
 */

const express = require('express');
const { logStockMovement } = require('../store');
const engine = require('../accounting/engine');
const posting = require('../accounting/posting');

const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';
const r2 = engine.r2;

const ledgerBalance = (store, partyId, partyType) => {
  const account = (store.accounts || []).find((a) => a.partyId === partyId && a.partyType === partyType);
  return account ? engine.accountBalance(store, account.id) : 0;
};

/* -------------------------------- customers -------------------------------- */

router.get('/customers', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.customers || []).map((c) => {
    const balance = ledgerBalance(store, c.id, 'CUSTOMER');
    return {
      ...c,
      outstanding: Math.max(0, balance),
      advance: Math.max(0, -balance),
      totalPurchases: r2(
        store.orders.filter((o) => o.customerId === c.id && o.status !== 'VOID').reduce((s, o) => s + o.total, 0)
      ),
      billCount: store.orders.filter((o) => o.customerId === c.id && o.status !== 'VOID').length
    };
  });

  const { q, group } = req.query;
  let filtered = rows;
  if (group && group !== 'ALL') filtered = filtered.filter((c) => c.group === group);
  if (q) {
    const needle = String(q).toLowerCase();
    filtered = filtered.filter(
      (c) => c.name.toLowerCase().includes(needle) || String(c.phone || '').includes(needle)
    );
  }

  res.json({ success: true, data: filtered });
});

router.post('/customers', (req, res) => {
  const store = req.tenantStore;
  const { name, phone, email, address, group, creditLimit, openingBalance } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Customer name is required.' });

  const customer = {
    id: `c_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    address: address || '',
    group: group || 'Retail',
    creditLimit: Number(creditLimit) || 0,
    outstanding: 0,
    loyaltyPoints: 0,
    createdAt: new Date().toISOString()
  };
  store.customers.push(customer);

  const account = engine.ensurePartyAccount(store, customer, 'CUSTOMER');
  if (Number(openingBalance)) {
    posting.postOpeningBalance(store, {
      accountId: account.id,
      amount: openingBalance,
      side: 'DR',
      createdBy: actor(req)
    });
    customer.outstanding = Number(openingBalance);
  }

  res.status(201).json({ success: true, data: { ...customer, accountId: account.id } });
});

router.put('/customers/:id', (req, res) => {
  const store = req.tenantStore;
  const customer = store.customers.find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const { outstanding, loyaltyPoints, id, ...safe } = req.body;
  Object.assign(customer, safe);

  const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
  if (account) account.name = customer.name;

  res.json({ success: true, data: customer });
});

router.get('/customers/:id/ledger', (req, res) => {
  const store = req.tenantStore;
  const account = (store.accounts || []).find((a) => a.partyId === req.params.id && a.partyType === 'CUSTOMER');
  if (!account) return res.json({ success: true, data: { entries: [], opening: 0, closing: 0 } });
  res.json({
    success: true,
    data: engine.accountLedger(store, account.id, { from: req.query.from, to: req.query.to })
  });
});

router.post('/customers/:id/send-whatsapp', (req, res) => {
  const store = req.tenantStore;
  const customer = store.customers.find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const balance = Math.max(0, ledgerBalance(store, customer.id, 'CUSTOMER'));
  const company = store.settings.company.name;
  const text = `Dear ${customer.name}, a friendly reminder from ${company}: an amount of ₹${balance.toLocaleString('en-IN')} is pending on your account. Kindly arrange payment at your convenience. Thank you!`;

  const phone = String(customer.phone || '').replace(/[^0-9]/g, '');
  res.json({
    success: true,
    message: `WhatsApp payment reminder prepared for ${customer.name}.`,
    data: {
      phone: customer.phone,
      amount: balance,
      text,
      waLink: phone ? `https://wa.me/${phone.length === 10 ? `91${phone}` : phone}?text=${encodeURIComponent(text)}` : null
    }
  });
});

router.get('/customer-groups', (req, res) => {
  const groups = [...new Set((req.tenantStore.customers || []).map((c) => c.group).filter(Boolean))];
  res.json({ success: true, data: groups.length ? groups : ['Retail', 'Wholesale', 'Staff'] });
});

/* --------------------------------- vendors --------------------------------- */

router.get('/vendors', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.vendors || []).map((v) => {
    const balance = ledgerBalance(store, v.id, 'VENDOR');
    const vendorPurchases = (store.purchases || []).filter((p) => p.vendorId === v.id);
    return {
      ...v,
      outstandingPayable: Math.max(0, balance),
      advancePaid: Math.max(0, -balance),
      purchaseCount: vendorPurchases.length,
      totalPurchased: r2(vendorPurchases.reduce((s, p) => s + p.totalAmount, 0))
    };
  });
  res.json({ success: true, data: rows });
});

router.post('/vendors', (req, res) => {
  const store = req.tenantStore;
  const { name, phone, email, gstin, address, outstandingPayable } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Vendor name is required.' });

  const vendor = {
    id: `v_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    gstin: gstin || '',
    address: address || '',
    outstandingPayable: 0,
    createdAt: new Date().toISOString()
  };
  store.vendors.push(vendor);

  const account = engine.ensurePartyAccount(store, vendor, 'VENDOR');
  if (Number(outstandingPayable)) {
    posting.postOpeningBalance(store, {
      accountId: account.id,
      amount: outstandingPayable,
      side: 'CR',
      createdBy: actor(req)
    });
    vendor.outstandingPayable = Number(outstandingPayable);
  }

  res.status(201).json({ success: true, data: { ...vendor, accountId: account.id } });
});

router.put('/vendors/:id', (req, res) => {
  const store = req.tenantStore;
  const vendor = store.vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const { outstandingPayable, id, ...safe } = req.body;
  Object.assign(vendor, safe);

  const account = (store.accounts || []).find((a) => a.partyId === vendor.id && a.partyType === 'VENDOR');
  if (account) account.name = vendor.name;

  res.json({ success: true, data: vendor });
});

router.delete('/vendors/:id', (req, res) => {
  const store = req.tenantStore;
  if ((store.purchases || []).some((p) => p.vendorId === req.params.id)) {
    return res.status(400).json({ success: false, message: 'Vendor has purchase history and cannot be deleted.' });
  }
  store.vendors = store.vendors.filter((v) => v.id !== req.params.id);
  res.json({ success: true, message: 'Vendor removed.' });
});

router.get('/vendors/:id/ledger', (req, res) => {
  const store = req.tenantStore;
  const account = (store.accounts || []).find((a) => a.partyId === req.params.id && a.partyType === 'VENDOR');
  if (!account) return res.json({ success: true, data: { entries: [], opening: 0, closing: 0 } });
  res.json({
    success: true,
    data: engine.accountLedger(store, account.id, { from: req.query.from, to: req.query.to })
  });
});

/* -------------------------------- purchases -------------------------------- */

router.get('/purchases', (req, res) => {
  const store = req.tenantStore;
  const { vendorId, from, to } = req.query;

  let rows = store.purchases || [];
  if (vendorId) rows = rows.filter((p) => p.vendorId === vendorId);
  if (from) rows = rows.filter((p) => engine.dayKey(p.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((p) => engine.dayKey(p.date) <= engine.dayKey(to));

  res.json({
    success: true,
    data: rows,
    summary: {
      count: rows.length,
      total: r2(rows.reduce((s, p) => s + p.totalAmount, 0)),
      unpaid: r2(rows.filter((p) => p.paymentStatus !== 'PAID').reduce((s, p) => s + p.totalAmount, 0))
    }
  });
});

/**
 * Purchase invoice. Line items receive stock at the invoiced cost and refresh
 * the product's purchase price, so margins stay accurate as costs move.
 */
router.post('/purchases', (req, res) => {
  const store = req.tenantStore;
  const {
    vendorId, vendorName, invoiceNo, items, totalAmount,
    paymentStatus, paymentMode, settlementAccountId, notes, date
  } = req.body;

  let vendor = vendorId ? store.vendors.find((v) => v.id === vendorId) : null;
  if (!vendor && vendorName) {
    vendor = store.vendors.find((v) => v.name.toLowerCase() === String(vendorName).toLowerCase());
    if (!vendor) {
      vendor = {
        id: `v_${Date.now()}`,
        name: vendorName,
        phone: '',
        email: '',
        gstin: '',
        address: '',
        outstandingPayable: 0,
        createdAt: new Date().toISOString()
      };
      store.vendors.push(vendor);
    }
  }

  const lines = Array.isArray(items) ? items : [];
  const subtotal = lines.length
    ? r2(lines.reduce((s, i) => s + Number(i.qty) * Number(i.rate), 0))
    : r2(totalAmount);
  const tax = lines.length
    ? r2(lines.reduce((s, i) => s + (Number(i.qty) * Number(i.rate) * Number(i.taxRate || 0)) / 100, 0))
    : r2(req.body.tax);
  const total = totalAmount !== undefined ? r2(totalAmount) : r2(subtotal + tax);

  const purchase = {
    id: `pur_${Date.now()}`,
    vendorId: vendor ? vendor.id : null,
    vendorName: vendor ? vendor.name : vendorName || 'Cash Purchase',
    invoiceNo: invoiceNo || `PUR-${Math.floor(1000 + Math.random() * 9000)}`,
    items: lines,
    subtotal,
    tax,
    totalAmount: total,
    paymentStatus: paymentStatus || 'UNPAID',
    paymentMode: paymentMode || 'Cash',
    settlementAccountId: settlementAccountId || null,
    notes: notes || '',
    receivedBy: actor(req),
    date: date || new Date().toISOString()
  };

  // Receive stock and refresh costing.
  lines.forEach((line) => {
    const product = store.products.find((p) => p.id === line.productId || p.name === line.name);
    if (!product) return;
    const qty = Number(line.qty);
    product.stock = r2(product.stock + qty);
    if (Number(line.rate)) product.purchasePrice = Number(line.rate);
    logStockMovement(store, {
      product,
      type: 'PURCHASE',
      qtyChange: qty,
      reason: `Received on ${purchase.invoiceNo}`,
      refId: purchase.id,
      user: actor(req)
    });
  });

  try {
    const voucher = posting.postPurchase(store, purchase, {
      vendor,
      interState: store.settings.tax.interState,
      createdBy: actor(req)
    });
    purchase.voucherId = voucher.id;
    purchase.voucherNo = voucher.voucherNo;
  } catch (err) {
    purchase.accountingError = err.message;
  }

  if (vendor) {
    const account = (store.accounts || []).find((a) => a.partyId === vendor.id && a.partyType === 'VENDOR');
    if (account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  }

  store.purchases.unshift(purchase);
  res.status(201).json({ success: true, message: 'Vendor purchase recorded.', data: purchase });
});

module.exports = router;
