/**
 * Customers, vendors and purchase management — Modules 6, 7 and 8 of the SOW.
 * Outstanding balances shown here are read straight from the party sub-ledgers
 * so they can never disagree with the Accounts module.
 */

const express = require('express');
const { logStockMovement, DEFAULT_CUSTOMER_GROUPS } = require('../store');
const engine = require('../accounting/engine');
const posting = require('../accounting/posting');
const { savePartyToDb, deletePartyFromDb } = require('../tenantProvisioner');

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

router.post('/customers', async (req, res) => {
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
  await savePartyToDb(req.tenantDbName, { ...customer, type: 'customer' });

  const account = engine.ensurePartyAccount(store, customer, 'CUSTOMER');
  if (Number(openingBalance)) {
    posting.postOpeningBalance(store, {
      accountId: account.id,
      amount: openingBalance,
      side: 'DR',
      createdBy: actor(req)
    });
    customer.outstanding = Number(openingBalance);
    await savePartyToDb(req.tenantDbName, { ...customer, type: 'customer' });
  }

  res.status(201).json({ success: true, data: { ...customer, accountId: account.id } });
});

router.put('/customers/:id', async (req, res) => {
  const store = req.tenantStore;
  const customer = store.customers.find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  // Whitelisted so the edit form's shared field set (it also carries vendor-only
  // keys like `outstandingPayable`/`changeReason` in its state object) can never
  // leak stray properties onto the customer record or clobber its field types.
  const { name, phone, email, address, group, creditLimit, gstin } = req.body;
  if (name !== undefined) customer.name = name;
  if (phone !== undefined) customer.phone = phone;
  if (email !== undefined) customer.email = email;
  if (address !== undefined) customer.address = address;
  if (group !== undefined) customer.group = group;
  if (creditLimit !== undefined) customer.creditLimit = Number(creditLimit) || 0;
  if (gstin !== undefined) customer.gstin = gstin;
  await savePartyToDb(req.tenantDbName, { ...customer, type: 'customer' });

  const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
  if (account) account.name = customer.name;

  res.json({ success: true, data: customer });
});

router.delete('/customers/:id', (req, res) => {
  const store = req.tenantStore;
  const customer = (store.customers || []).find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  // History and money owed both anchor to the customer record, so neither may be
  // orphaned by a delete — deactivating keeps the ledger readable.
  const balance = ledgerBalance(store, customer.id, 'CUSTOMER');
  if (Math.abs(balance) > 0.009) {
    return res.status(400).json({
      success: false,
      message: `${customer.name} has an open balance of ₹${Math.abs(balance).toFixed(2)}. Settle it before removing the customer.`
    });
  }

  const bills = store.orders.filter((o) => o.customerId === customer.id);
  if (bills.length) {
    customer.isActive = false;
    return res.json({
      success: true,
      message: `${customer.name} has ${bills.length} bill(s) on record and was deactivated instead of deleted.`,
      data: customer
    });
  }

  store.customers = store.customers.filter((c) => c.id !== customer.id);
  store.accounts = (store.accounts || []).filter(
    (a) => !(a.partyId === customer.id && a.partyType === 'CUSTOMER')
  );

  res.json({ success: true, message: `${customer.name} removed.` });
});

/**
 * Loyalty balance and what it is worth at the counter — Module 3.
 * The redeem value is a shop setting, so the POS never has to guess the rate.
 */
router.get('/customers/:id/loyalty', (req, res) => {
  const store = req.tenantStore;
  const customer = (store.customers || []).find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const pos = store.settings.pos || {};
  const points = customer.loyaltyPoints || 0;
  const minPoints = Number(pos.loyaltyMinRedeemPoints) || 0;

  res.json({
    success: true,
    data: {
      customerId: customer.id,
      name: customer.name,
      points,
      redeemValuePerPoint: Number(pos.loyaltyRedeemValue) || 0,
      pointsPerHundred: Number(pos.loyaltyPointsPerHundred) || 0,
      minRedeemPoints: minPoints,
      redeemable: points >= minPoints,
      maxRedeemableAmount: r2(points * (Number(pos.loyaltyRedeemValue) || 0)),
      enabled: pos.enableLoyalty !== false
    }
  });
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



function getGroups(store) {
  if (!Array.isArray(store.customerGroups) || store.customerGroups.length === 0) {
    store.customerGroups = [...DEFAULT_CUSTOMER_GROUPS];
  }
  return store.customerGroups;
}

router.get('/customer-groups', (req, res) => {
  const store = req.tenantStore;
  const groups = getGroups(store);

  // Any group name typed straight onto a customer before groups were managed
  // still shows up here, so nothing is lost when the list is formalised.
  const known = new Set(groups.map((g) => g.name));
  const orphans = [...new Set((store.customers || []).map((c) => c.group).filter((g) => g && !known.has(g)))];

  const rows = [
    ...groups,
    ...orphans.map((name) => ({ id: `grp_${name.toLowerCase()}`, name, discountPercent: 0, priceSheetId: null, adhoc: true }))
  ].map((group) => ({
    ...group,
    customerCount: (store.customers || []).filter((c) => c.group === group.name).length
  }));

  res.json({ success: true, data: rows, names: rows.map((g) => g.name) });
});

router.post('/customer-groups', (req, res) => {
  const store = req.tenantStore;
  const groups = getGroups(store);
  const { name, discountPercent, priceSheetId } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Group name is required.' });
  }
  if (groups.some((g) => g.name.toLowerCase() === String(name).trim().toLowerCase())) {
    return res.status(400).json({ success: false, message: 'A group with that name already exists.' });
  }

  const group = {
    id: `grp_${Date.now()}`,
    name: String(name).trim(),
    discountPercent: Number(discountPercent) || 0,
    priceSheetId: priceSheetId || null,
    isDefault: false,
    createdAt: new Date().toISOString()
  };

  groups.push(group);
  res.status(201).json({ success: true, message: `Customer group "${group.name}" created.`, data: group });
});

router.put('/customer-groups/:id', (req, res) => {
  const store = req.tenantStore;
  const group = getGroups(store).find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Customer group not found.' });

  const { name, discountPercent, priceSheetId } = req.body;

  // Renaming re-tags the members, so nobody is left pointing at a group that
  // no longer exists.
  if (name && String(name).trim() && String(name).trim() !== group.name) {
    const previous = group.name;
    group.name = String(name).trim();
    (store.customers || []).forEach((c) => {
      if (c.group === previous) c.group = group.name;
    });
  }

  if (discountPercent !== undefined) group.discountPercent = Number(discountPercent) || 0;
  if (priceSheetId !== undefined) group.priceSheetId = priceSheetId || null;

  res.json({ success: true, message: `Group "${group.name}" updated.`, data: group });
});

router.delete('/customer-groups/:id', (req, res) => {
  const store = req.tenantStore;
  const groups = getGroups(store);
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Customer group not found.' });

  const members = (store.customers || []).filter((c) => c.group === group.name);
  if (members.length) {
    return res.status(400).json({
      success: false,
      message: `${members.length} customer(s) are in "${group.name}". Move them to another group first.`
    });
  }

  store.customerGroups = groups.filter((g) => g.id !== group.id);
  res.json({ success: true, message: `Group "${group.name}" removed.` });
});

router.post('/customer-groups/:id/assign', (req, res) => {
  const store = req.tenantStore;
  const group = getGroups(store).find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Customer group not found.' });

  const ids = Array.isArray(req.body.customerIds) ? req.body.customerIds : [];
  let moved = 0;
  (store.customers || []).forEach((c) => {
    if (ids.includes(c.id)) {
      c.group = group.name;
      moved += 1;
    }
  });

  res.json({ success: true, message: `${moved} customer(s) allocated to "${group.name}".`, data: { group, moved } });
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

router.post('/vendors', async (req, res) => {
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
  await savePartyToDb(req.tenantDbName, { ...vendor, type: 'vendor' });

  const account = engine.ensurePartyAccount(store, vendor, 'VENDOR');
  if (Number(outstandingPayable)) {
    posting.postOpeningBalance(store, {
      accountId: account.id,
      amount: outstandingPayable,
      side: 'CR',
      createdBy: actor(req)
    });
    vendor.outstandingPayable = Number(outstandingPayable);
    await savePartyToDb(req.tenantDbName, { ...vendor, type: 'vendor' });
  }

  res.status(201).json({ success: true, data: { ...vendor, accountId: account.id } });
});

router.put('/vendors/:id', async (req, res) => {
  const store = req.tenantStore;
  const vendor = store.vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const {
    name,
    phone,
    email,
    gstin,
    address,
    category,
    contactPerson,
    paymentTerms,
    outstandingPayable,
    changeReason
  } = req.body;

  const changedFields = [];

  const compareAndTrack = (field, label, newVal, oldVal) => {
    if (newVal !== undefined && String(newVal ?? '').trim() !== String(oldVal ?? '').trim()) {
      changedFields.push({
        field: label || field,
        old: oldVal || '—',
        new: newVal || '—'
      });
    }
  };

  compareAndTrack('name', 'Vendor Name', name, vendor.name);
  compareAndTrack('phone', 'Phone Number', phone, vendor.phone);
  compareAndTrack('email', 'Email Address', email, vendor.email);
  compareAndTrack('gstin', 'GSTIN', gstin, vendor.gstin);
  compareAndTrack('address', 'Address', address, vendor.address);
  compareAndTrack('category', 'Category', category, vendor.category);
  compareAndTrack('contactPerson', 'Contact Person', contactPerson, vendor.contactPerson);
  compareAndTrack('paymentTerms', 'Payment Terms', paymentTerms, vendor.paymentTerms);

  // Apply core field updates
  if (name !== undefined) vendor.name = name;
  if (phone !== undefined) vendor.phone = phone;
  if (email !== undefined) vendor.email = email;
  if (gstin !== undefined) vendor.gstin = gstin;
  if (address !== undefined) vendor.address = address;
  if (category !== undefined) vendor.category = category;
  if (contactPerson !== undefined) vendor.contactPerson = contactPerson;
  if (paymentTerms !== undefined) vendor.paymentTerms = paymentTerms;

  const account = engine.ensurePartyAccount(store, vendor, 'VENDOR');

  // Handle editable Amount Payable adjustment
  if (outstandingPayable !== undefined && outstandingPayable !== null && outstandingPayable !== '') {
    const newPayable = Number(outstandingPayable) || 0;
    const currentPayable = Number(vendor.outstandingPayable || 0);

    if (Math.abs(newPayable - currentPayable) > 0.001) {
      changedFields.push({
        field: 'Amount Payable',
        old: `₹${currentPayable.toLocaleString('en-IN')}`,
        new: `₹${newPayable.toLocaleString('en-IN')}`
      });

      const diff = newPayable - currentPayable;
      posting.postOpeningBalance(store, {
        accountId: account.id,
        amount: Math.abs(diff),
        side: diff > 0 ? 'CR' : 'DR',
        createdBy: actor(req)
      });
      vendor.outstandingPayable = newPayable;
    }
  }

  // Record modification history entry if any fields changed
  if (changedFields.length > 0) {
    vendor.history = vendor.history || [];
    vendor.history.unshift({
      id: `vh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      user: actor(req),
      reason: changeReason || 'Vendor details updated',
      changes: changedFields
    });
  }

  await savePartyToDb(req.tenantDbName, { ...vendor, type: 'vendor' });

  if (account) account.name = vendor.name;

  res.json({ success: true, message: 'Vendor details updated successfully.', data: vendor });
});

router.get('/vendors/:id/history', (req, res) => {
  const store = req.tenantStore;
  const vendor = (store.vendors || []).find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });
  res.json({ success: true, data: vendor.history || [] });
});

router.delete('/vendors/:id', (req, res) => {
  const store = req.tenantStore;
  const vendor = (store.vendors || []).find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  if ((store.purchases || []).some((p) => p.vendorId === vendor.id)) {
    return res.status(400).json({ success: false, message: 'Vendor has purchase history and cannot be deleted.' });
  }

  // Mirrors the customer guard: a vendor with money still owed to them must not
  // be removable, or the payable becomes permanently invisible while the ledger
  // that tracks it silently keeps the real balance forever.
  const balance = ledgerBalance(store, vendor.id, 'VENDOR');
  if (Math.abs(balance) > 0.009) {
    return res.status(400).json({
      success: false,
      message: `${vendor.name} has an open balance of ₹${Math.abs(balance).toFixed(2)}. Settle it before removing the vendor.`
    });
  }

  store.vendors = store.vendors.filter((v) => v.id !== vendor.id);
  store.accounts = (store.accounts || []).filter(
    (a) => !(a.partyId === vendor.id && a.partyType === 'VENDOR')
  );
  res.json({ success: true, message: `${vendor.name} removed.` });
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

  let rows = [...(store.purchases || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (vendorId) rows = rows.filter((p) => p.vendorId === vendorId);
  if (from) rows = rows.filter((p) => engine.dayKey(p.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((p) => engine.dayKey(p.date) <= engine.dayKey(to));

  res.json({
    success: true,
    data: rows,
    summary: {
      count: rows.length,
      total: r2(rows.reduce((s, p) => s + (Number(p.totalAmount) || 0), 0)),
      unpaid: r2(rows.filter((p) => p.paymentStatus !== 'PAID').reduce((s, p) => s + (Number(p.totalAmount) || 0), 0))
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

  lines.forEach((line) => {
    const product = store.products.find((p) => p.id === line.productId || p.name === line.name);
    if (!product) return;
    const qty = Number(line.qty);
    product.stock = r2(Number(product.stock || 0) + qty);
    if (product.warehouses && typeof product.warehouses === 'object') {
      const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
      product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) + qty);
      product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
    }
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

/**
 * Vendor Cash Payment — Module 6.
 *
 * Settling a supplier from the purchases screen without leaving for the Accounts
 * module. The payment posts through the same voucher path as `/accounts/payments`,
 * so the vendor ledger, the cash/bank balance and the payables report all move
 * together. Oldest invoices are marked paid first, which is how shops actually
 * apply a lump-sum payment.
 */
router.post('/vendors/:id/pay', (req, res) => {
  const store = req.tenantStore;
  const vendor = (store.vendors || []).find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const { amount, discount, paymentMode, settlementAccountId, reference, notes, date } = req.body;
  if (!Number(amount)) {
    return res.status(400).json({ success: false, message: 'Payment amount is required.' });
  }

  const record = {
    id: `pay_${Date.now()}`,
    vendorId: vendor.id,
    vendorName: vendor.name,
    amount: r2(amount),
    discount: r2(discount),
    paymentMode: paymentMode || 'Cash',
    settlementAccountId: settlementAccountId || null,
    reference: reference || '',
    notes: notes || `Payment to ${vendor.name}`,
    date: date || new Date().toISOString()
  };

  let voucher;
  try {
    voucher = posting.postPayment(store, record, { vendor, createdBy: actor(req) });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  record.voucherId = voucher.id;
  record.voucherNo = voucher.voucherNo;
  if (!Array.isArray(store.payments)) store.payments = [];
  store.payments.unshift(record);

  let remaining = record.amount + r2(discount);
  const settled = [];
  (store.purchases || [])
    .filter((p) => p.vendorId === vendor.id && p.paymentStatus !== 'PAID')
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((purchase) => {
      if (remaining <= 0.009) return;
      const due = r2(purchase.totalAmount - (purchase.paidAmount || 0));
      const applied = Math.min(due, remaining);
      purchase.paidAmount = r2((purchase.paidAmount || 0) + applied);
      purchase.paymentStatus = purchase.paidAmount >= purchase.totalAmount - 0.009 ? 'PAID' : 'PARTIAL';
      remaining = r2(remaining - applied);
      settled.push({ invoiceNo: purchase.invoiceNo, applied, status: purchase.paymentStatus });
    });

  // Cash leaving the counter drawer is also a drawer movement.
  if (String(record.paymentMode).toLowerCase() === 'cash' && store.session?.status === 'open') {
    store.session.currentCash = r2(store.session.currentCash - record.amount);
    store.session.cashEntries.push({
      type: 'OUT',
      amount: record.amount,
      reason: `Vendor payment — ${vendor.name}`,
      time: record.date,
      user: actor(req)
    });
  }

  const account = (store.accounts || []).find((a) => a.partyId === vendor.id && a.partyType === 'VENDOR');
  if (account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));

  res.status(201).json({
    success: true,
    message: `Paid ₹${record.amount.toFixed(2)} to ${vendor.name} (${voucher.voucherNo}).`,
    data: {
      payment: record,
      settled,
      unapplied: r2(remaining),
      outstandingPayable: vendor.outstandingPayable
    }
  });
});

module.exports = router;
