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
const { shapeProduct } = require('../controllers/catalog.controller');
const { addBatch, voidPurchaseBatches, writeOffBatch } = require('../controllers/batches');
const { baseQty, isWholeNumberUnit } = require('../controllers/unitConversion');

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
  try {
    const store = req.tenantStore;
    const {
      name,
      phone,
      email,
      address,
      group,
      creditLimit,
      openingBalance,
      openingAdvance,
      advanceBalance,
      loyaltyPoints,
      gstin,
      pan,
      priceSheetId,
      state,
      stateCode
    } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Customer name is required.' });

    const customer = {
      id: `c_${Date.now()}`,
      name,
      phone: phone || '',
      email: email || '',
      address: address || '',
      group: group || 'Retail',
      creditLimit: Number(creditLimit) || 0,
      gstin: gstin || '',
      pan: pan || '',
      state: state || '',
      stateCode: stateCode || '',
      priceSheetId: priceSheetId || null,
      outstanding: 0,
      advance: 0,
      loyaltyPoints: Number(loyaltyPoints) || 0,
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
    } else if (Number(openingAdvance) || Number(advanceBalance)) {
      const advAmount = Number(openingAdvance || advanceBalance);
      posting.postOpeningBalance(store, {
        accountId: account.id,
        amount: advAmount,
        side: 'CR',
        createdBy: actor(req)
      });
      customer.advance = advAmount;
      await savePartyToDb(req.tenantDbName, { ...customer, type: 'customer' });
    }

    res.status(201).json({ success: true, data: { ...customer, accountId: account.id } });
  } catch (err) {
    console.error('[POST /customers]', err);
    res.status(500).json({ success: false, message: 'Could not save the customer. Please try again.' });
  }
});

router.put('/customers/:id', async (req, res) => {
  try {
    const store = req.tenantStore;
    const customer = store.customers.find((c) => c.id === req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const {
      name,
      phone,
      email,
      address,
      group,
      creditLimit,
      gstin,
      pan,
      priceSheetId,
      state,
      stateCode,
      loyaltyPoints,
      outstandingReceivable,
      advanceBalance,
      openingAdvance
    } = req.body;

    if (name !== undefined) customer.name = name;
    if (phone !== undefined) customer.phone = phone;
    if (email !== undefined) customer.email = email;
    if (address !== undefined) customer.address = address;
    if (group !== undefined) customer.group = group;
    if (creditLimit !== undefined) customer.creditLimit = Number(creditLimit) || 0;
    if (gstin !== undefined) customer.gstin = gstin;
    if (pan !== undefined) customer.pan = pan;
    if (state !== undefined) customer.state = state;
    if (stateCode !== undefined) customer.stateCode = stateCode;
    if (priceSheetId !== undefined) customer.priceSheetId = priceSheetId || null;
    if (loyaltyPoints !== undefined) customer.loyaltyPoints = Number(loyaltyPoints) || 0;

    const account = engine.ensurePartyAccount(store, customer, 'CUSTOMER');
    if (account) account.name = customer.name;

    // Receivable and advance are opposite sides of the one sub-ledger balance
    // (owed BY the customer vs. owed TO them), so both fields target the same
    // account and are combined into one net figure rather than posted separately
    // — posting them independently against a stale "current side only" reading
    // used to land on the wrong balance whenever the customer already carried
    // some amount on the other side (e.g. setting advance while a receivable
    // was outstanding silently left a leftover receivable behind).
    const targetAdvance = advanceBalance !== undefined ? advanceBalance : openingAdvance;
    const hasReceivableInput = outstandingReceivable !== undefined && outstandingReceivable !== null && outstandingReceivable !== '';
    const hasAdvanceInput = targetAdvance !== undefined && targetAdvance !== null && targetAdvance !== '';

    if (hasReceivableInput || hasAdvanceInput) {
      const receivablePart = hasReceivableInput ? Number(outstandingReceivable) || 0 : 0;
      const advancePart = hasAdvanceInput ? Number(targetAdvance) || 0 : 0;
      const targetBalance = receivablePart - advancePart;

      const currentLedgerBal = ledgerBalance(store, customer.id, 'CUSTOMER');
      const diff = targetBalance - currentLedgerBal;

      if (Math.abs(diff) > 0.001) {
        posting.postOpeningBalance(store, {
          accountId: account.id,
          amount: Math.abs(diff),
          side: diff > 0 ? 'DR' : 'CR',
          createdBy: actor(req)
        });
        customer.outstanding = Math.max(0, targetBalance);
        customer.advance = Math.max(0, -targetBalance);
      }
    }

    await savePartyToDb(req.tenantDbName, { ...customer, type: 'customer' });

    res.json({ success: true, data: customer });
  } catch (err) {
    console.error('[PUT /customers/:id]', err);
    res.status(500).json({ success: false, message: 'Could not update the customer. Please try again.' });
  }
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
      redeemValuePerPoint: Number(pos.loyaltyRedeemValue) || 0.5,
      spendAmount: Number(pos.loyaltySpendAmount) || 100,
      pointsPerSpend: Number(pos.loyaltyPointsPerSpend ?? pos.loyaltyPointsPerHundred) || 1,
      pointsPerHundred: Number(pos.loyaltyPointsPerHundred ?? pos.loyaltyPointsPerSpend) || 1,
      minSpendToEarn: Number(pos.loyaltyMinSpendToEarn) || 0,
      minRedeemPoints: minPoints,
      maxRedeemPercent: Number(pos.loyaltyMaxRedeemPercent) || 100,
      redeemable: points >= minPoints,
      maxRedeemableAmount: r2(points * (Number(pos.loyaltyRedeemValue) || 0.5)),
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
    const vendorPurchases = (store.purchases || []).filter((p) => p.vendorId === v.id && p.status !== 'VOID');
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
  try {
    const store = req.tenantStore;
    const { name, phone, email, gstin, pan, address, outstandingPayable } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Vendor name is required.' });

    const vendor = {
      id: `v_${Date.now()}`,
      name,
      phone: phone || '',
      email: email || '',
      gstin: gstin || '',
      pan: pan || '',
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
  } catch (err) {
    console.error('[POST /vendors]', err);
    res.status(500).json({ success: false, message: 'Could not save the vendor. Please try again.' });
  }
});

router.put('/vendors/:id', async (req, res) => {
  try {
  const store = req.tenantStore;
  const vendor = store.vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const {
    name,
    phone,
    email,
    gstin,
    pan,
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
  compareAndTrack('pan', 'PAN', pan, vendor.pan);
  compareAndTrack('address', 'Address', address, vendor.address);
  compareAndTrack('category', 'Category', category, vendor.category);
  compareAndTrack('contactPerson', 'Contact Person', contactPerson, vendor.contactPerson);
  compareAndTrack('paymentTerms', 'Payment Terms', paymentTerms, vendor.paymentTerms);

  // Apply core field updates
  if (name !== undefined) vendor.name = name;
  if (phone !== undefined) vendor.phone = phone;
  if (email !== undefined) vendor.email = email;
  if (gstin !== undefined) vendor.gstin = gstin;
  if (pan !== undefined) vendor.pan = pan;
  if (address !== undefined) vendor.address = address;
  if (category !== undefined) vendor.category = category;
  if (contactPerson !== undefined) vendor.contactPerson = contactPerson;
  if (paymentTerms !== undefined) vendor.paymentTerms = paymentTerms;

  const account = engine.ensurePartyAccount(store, vendor, 'VENDOR');

  // Handle editable Amount Payable adjustment. The target is the account's net
  // ledger balance, read fresh here rather than off `vendor.outstandingPayable`
  // — that stored field is clamped to zero (Math.max(0, ...)) everywhere else
  // it's written, so if the vendor ever carried an advance-paid (negative)
  // balance, diffing against the clamped field posted the wrong amount and the
  // vendor never actually landed on the payable figure that was typed in.
  if (outstandingPayable !== undefined && outstandingPayable !== null && outstandingPayable !== '') {
    const newPayable = Number(outstandingPayable) || 0;
    const currentLedgerBal = ledgerBalance(store, vendor.id, 'VENDOR');
    const diff = newPayable - currentLedgerBal;

    if (Math.abs(diff) > 0.001) {
      changedFields.push({
        field: 'Amount Payable',
        old: `₹${Math.max(0, currentLedgerBal).toLocaleString('en-IN')}`,
        new: `₹${newPayable.toLocaleString('en-IN')}`
      });

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
  } catch (err) {
    console.error('[PUT /vendors/:id]', err);
    res.status(500).json({ success: false, message: 'Could not update the vendor. Please try again.' });
  }
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

  const today = engine.dayKey(new Date());
  const isOverdue = (p) =>
    p.status !== 'VOID' && p.paymentStatus !== 'PAID' && !!p.dueDate && engine.dayKey(p.dueDate) < today;
  rows = rows.map((p) => ({ ...p, isOverdue: isOverdue(p) }));

  const active = rows.filter((p) => p.status !== 'VOID');
  const overdue = active.filter((p) => p.isOverdue);

  res.json({
    success: true,
    data: rows,
    summary: {
      count: active.length,
      total: r2(active.reduce((s, p) => s + (Number(p.totalAmount) || 0), 0)),
      unpaid: r2(active.filter((p) => p.paymentStatus !== 'PAID').reduce((s, p) => s + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0), 0)),
      overdueCount: overdue.length,
      overdueAmount: r2(overdue.reduce((s, p) => s + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0), 0))
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
    paymentStatus, paymentMode, settlementAccountId, notes, date,
    dueDate, poId, additionalCharges, landedCostPaymentMode, landedCostSettlementAccountId
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

  if (vendor && invoiceNo && String(invoiceNo).trim()) {
    const duplicate = (store.purchases || []).some(
      (p) => p.vendorId === vendor.id && p.status !== 'VOID' && String(p.invoiceNo).trim().toLowerCase() === String(invoiceNo).trim().toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Invoice ${invoiceNo} is already recorded for ${vendor.name}. Check the purchase list before re-entering it.`
      });
    }
  }

  // Receiving against a purchase order — validated up front so a bad/expired
  // poId fails loudly instead of silently creating an unlinked purchase.
  let purchaseOrder = null;
  if (poId) {
    purchaseOrder = (store.purchaseOrders || []).find((p) => p.id === poId);
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found.' });
    if (purchaseOrder.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: `Purchase order ${purchaseOrder.poNumber} was cancelled.` });
    }
    if (purchaseOrder.status === 'RECEIVED') {
      return res.status(400).json({ success: false, message: `Purchase order ${purchaseOrder.poNumber} has already been fully received.` });
    }
    if (vendor && purchaseOrder.vendorId !== vendor.id) {
      return res.status(400).json({ success: false, message: `Vendor does not match purchase order ${purchaseOrder.poNumber}.` });
    }
  }

  const lines = Array.isArray(items) ? items : [];

  // Same whole-number rule as billing: a line received in a discrete-count
  // unit (pcs, box, dozen, ...) can't carry a fractional quantity.
  const fractionalLine = lines.find((i) => {
    const unit = i.unit || 'pcs';
    const qty = Number(i.qty);
    return isWholeNumberUnit(unit) && Number.isFinite(qty) && qty % 1 !== 0;
  });
  if (fractionalLine) {
    return res.status(400).json({
      success: false,
      message: `"${fractionalLine.name || 'Item'}" is received in ${fractionalLine.unit} — quantity must be a whole number.`
    });
  }

  const subtotal = lines.length
    ? r2(lines.reduce((s, i) => s + Number(i.qty) * Number(i.rate), 0))
    : r2(totalAmount);
  const tax = lines.length
    ? r2(lines.reduce((s, i) => s + (Number(i.qty) * Number(i.rate) * Number(i.taxRate || 0)) / 100, 0))
    : r2(req.body.tax);
  const total = totalAmount !== undefined ? r2(totalAmount) : r2(subtotal + tax);

  const chargeLines = (Array.isArray(additionalCharges) ? additionalCharges : []).filter((c) => Number(c.amount) > 0);
  const totalAdditionalCharges = r2(chargeLines.reduce((s, c) => s + Number(c.amount || 0), 0));

  const paid = req.body.paidAmount !== undefined
    ? Math.min(total, Math.max(0, r2(req.body.paidAmount)))
    : (paymentStatus === 'PAID' ? total : 0);
  const status = paid >= total ? 'PAID' : paid > 0 ? 'PARTIAL' : (paymentStatus || 'UNPAID');

  const purchase = {
    id: `pur_${Date.now()}`,
    vendorId: vendor ? vendor.id : null,
    vendorName: vendor ? vendor.name : vendorName || 'Cash Purchase',
    vendorPhone: req.body.vendorPhone || vendor?.phone || '',
    vendorGstin: req.body.vendorGstin || vendor?.gstin || '',
    vendorPan: req.body.vendorPan || vendor?.pan || '',
    vendorAddress: req.body.vendorAddress || vendor?.address || '',
    vendorState: req.body.vendorState || vendor?.state || '',
    vendorStateCode: req.body.vendorStateCode || vendor?.stateCode || '',
    invoiceNo: invoiceNo || `PUR-${Math.floor(1000 + Math.random() * 9000)}`,
    items: lines,
    subtotal,
    discount: r2(req.body.discount || 0),
    tax,
    roundOff: r2(req.body.roundOff || 0),
    totalAmount: total,
    additionalCharges: chargeLines.map((c) => ({ label: c.label || 'Other', amount: r2(c.amount) })),
    totalAdditionalCharges,
    paidAmount: paid,
    paymentStatus: status,
    paymentMode: paymentMode || 'Cash',
    paymentRef: req.body.paymentRef || '',
    settlementAccountId: settlementAccountId || null,
    placeOfSupply: req.body.placeOfSupply || '',
    dispatchFrom: req.body.dispatchFrom || '',
    dispatchDate: req.body.dispatchDate || null,
    shipToName: req.body.shipToName || '',
    shipToAddress: req.body.shipToAddress || '',
    vehicleNo: req.body.vehicleNo || '',
    shipBy: req.body.shipBy || '',
    transporterName: req.body.transporterName || '',
    dispatchDocNo: req.body.dispatchDocNo || '',
    buyerOrderNo: req.body.buyerOrderNo || '',
    buyerOrderDate: req.body.buyerOrderDate || null,
    termsOfDelivery: req.body.termsOfDelivery || '',
    paymentTerms: req.body.paymentTerms || '',
    notes: notes || '',
    receivedBy: actor(req),
    date: date || new Date().toISOString(),
    dueDate: dueDate || null,
    poId: purchaseOrder ? purchaseOrder.id : null,
    poNumber: purchaseOrder ? purchaseOrder.poNumber : null
  };

  // Receiving under a batch number this product already has on file would
  // otherwise make that batch ambiguous — two physically different lots
  // sharing one traceable number. Rather than failing the whole purchase over
  // a naming collision (an existing working flow must keep working), fall
  // back to the next auto-generated number and flag it on the purchase so
  // it's visible in the purchase record, not silently swapped.
  const batchNoWarnings = [];
  const addBatchSafely = (product, opts) => {
    try {
      return addBatch(product, opts);
    } catch (err) {
      batchNoWarnings.push(
        `${product.name || 'Item'}: requested batch "${opts.batchNo}" was already in use — assigned a new batch number instead.`
      );
      return addBatch(product, { ...opts, batchNo: undefined });
    }
  };

  const createdProducts = [];
  lines.forEach((line) => {
    let product = store.products.find(
      (p) => p.id === line.productId || (line.name && p.name.toLowerCase() === String(line.name).toLowerCase())
    );

    // Receiving stock for something that isn't in the catalogue yet used to just
    // silently drop the line — no stock, no product, nothing on the invoice or
    // in billing. Create it instead, so a purchase always lands somewhere.
    if (!product && line.name) {
      const rate = Number(line.rate) || 0;
      product = shapeProduct(
        store,
        {
          name: line.name,
          unit: line.unit || 'pcs',
          hsn: line.hsn || '',
          taxRate: Number(line.taxRate) || 0,
          purchasePrice: rate,
          price: rate > 0 ? Math.round(rate / 0.7) : 0,
          stock: 0
        },
        null,
        actor(req)
      );
      store.products.unshift(product);
      createdProducts.push(product);
      line.productId = product.id;
    }

    if (!product) return;
    // A purchase line entered in a different unit than the product's base
    // unit (e.g. receiving "2 bags" of a product tracked in kg) needs the
    // same conversion sales already apply, otherwise stock silently drifts —
    // "2" would get added instead of "50".
    const qty = baseQty(product, { unit: line.unit, qty: Number(line.qty) });

    // Cost is stored per BASE unit everywhere it's consumed (batch costPrice,
    // COGS, margin reports all multiply it against a base-unit quantity), so
    // `line.rate` — quoted per the line's own unit (₹/bag, ₹/box, …) — has to
    // be converted the same way `qty` just was, not stored as-is. Any landed
    // cost allocated to this line is folded in here too, so the stored cost
    // is the item's true fully-loaded per-base-unit price from day one.
    const lineValue = Number(line.qty) * Number(line.rate || 0);
    const allocatedCharge =
      totalAdditionalCharges > 0
        ? subtotal > 0
          ? r2(totalAdditionalCharges * (lineValue / subtotal))
          : r2(totalAdditionalCharges / lines.length)
        : 0;
    const costPerBaseUnit = qty > 0 ? r2((lineValue + allocatedCharge) / qty) : Number(line.rate) || 0;

    if (product.trackBatches) {
      const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
      if (Array.isArray(line.batches) && line.batches.length > 0) {
        line.batches.forEach((b) => {
          const bQty = baseQty(product, { unit: line.unit, qty: Number(b.qty || 0) });
          if (bQty <= 0) return;
          const batch = addBatchSafely(product, {
            batchNo: b.batchNo,
            mfgDate: b.mfgDate,
            expiryDate: b.expiryDate,
            qty: bQty,
            costPrice: costPerBaseUnit,
            sellPrice: b.sellPrice !== undefined && b.sellPrice !== '' ? b.sellPrice : line.sellPrice,
            refPurchaseId: purchase.id,
            warehouseId: b.warehouseId || line.warehouseId || whKey
          });
          b.batchId = batch.id;
          b.batchNo = batch.batchNo;
        });
        if (line.batches[0]) {
          line.batchId = line.batches[0].batchId;
          line.batchNo = line.batches[0].batchNo;
        }
      } else {
        const batch = addBatchSafely(product, {
          batchNo: line.batchNo,
          mfgDate: line.mfgDate,
          expiryDate: line.expiryDate,
          qty,
          costPrice: costPerBaseUnit,
          sellPrice: line.sellPrice,
          refPurchaseId: purchase.id,
          warehouseId: line.warehouseId || whKey
        });
        line.batchId = batch.id;
        line.batchNo = batch.batchNo;
      }
    } else {
      product.stock = r2(Number(product.stock || 0) + qty);
      if (product.warehouses && typeof product.warehouses === 'object') {
        const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
        product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) + qty);
        product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
      }
      if (line.sellPrice !== undefined && line.sellPrice !== '' && Number(line.sellPrice) > 0) {
        product.price = Number(line.sellPrice);
      }
    }
    if (costPerBaseUnit) product.purchasePrice = costPerBaseUnit;
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

  // Cash paid to the vendor up front (at purchase entry, not the separate
  // "settle due" screen) leaves the till just the same — the counter drawer
  // needs to see it or its expected balance drifts from the ledger.
  if (paid > 0 && String(purchase.paymentMode).toLowerCase() === 'cash' && store.session?.status === 'open') {
    store.session.currentCash = r2(store.session.currentCash - paid);
    store.session.cashEntries.push({
      type: 'OUT',
      amount: paid,
      reason: `Vendor payment — ${purchase.vendorName} (Purchase ${purchase.invoiceNo})`,
      time: purchase.date,
      user: actor(req)
    });
  }

  if (totalAdditionalCharges > 0) {
    try {
      const landedVoucher = posting.postLandedCost(store, purchase, {
        amount: totalAdditionalCharges,
        paymentMode: landedCostPaymentMode || 'Cash',
        settlementAccountId: landedCostSettlementAccountId || null,
        createdBy: actor(req)
      });
      if (landedVoucher) {
        purchase.landedCostVoucherId = landedVoucher.id;
        purchase.landedCostVoucherNo = landedVoucher.voucherNo;
      }
    } catch (err) {
      purchase.landedCostAccountingError = err.message;
    }

    // Same drawer-movement treatment for landed cost (freight/handling) when
    // it's settled in cash at receiving time.
    if (String(landedCostPaymentMode || 'Cash').toLowerCase() === 'cash' && store.session?.status === 'open') {
      store.session.currentCash = r2(store.session.currentCash - totalAdditionalCharges);
      store.session.cashEntries.push({
        type: 'OUT',
        amount: totalAdditionalCharges,
        reason: `Landed cost — Purchase ${purchase.invoiceNo}`,
        time: purchase.date,
        user: actor(req)
      });
    }
  }

  if (vendor) {
    const account = (store.accounts || []).find((a) => a.partyId === vendor.id && a.partyType === 'VENDOR');
    if (account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  }

  // Mark off what this bill actually received against the purchase order —
  // by product, not by line index, so receiving fewer/more lines than the PO
  // still reconciles correctly line-by-line.
  if (purchaseOrder) {
    lines.forEach((line) => {
      const poLine = purchaseOrder.items.find((pl) => pl.productId === line.productId);
      if (!poLine) return;
      const product = store.products.find((p) => p.id === line.productId);
      const receivedQty = product ? baseQty(product, { unit: line.unit, qty: Number(line.qty) }) : Number(line.qty) || 0;
      poLine.receivedQty = r2((poLine.receivedQty || 0) + receivedQty);
    });
    const allReceived = purchaseOrder.items.every((l) => l.receivedQty >= l.orderedQty - 0.009);
    const anyReceived = purchaseOrder.items.some((l) => l.receivedQty > 0.009);
    purchaseOrder.status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : purchaseOrder.status;
    if (!Array.isArray(purchaseOrder.purchaseIds)) purchaseOrder.purchaseIds = [];
    purchaseOrder.purchaseIds.push(purchase.id);
  }

  if (batchNoWarnings.length) purchase.batchNoWarnings = batchNoWarnings;

  store.purchases.unshift(purchase);

  const message = createdProducts.length
    ? `Vendor purchase recorded. ${createdProducts.length} new product(s) added to the catalogue: ${createdProducts.map((p) => p.name).join(', ')}.`
    : 'Vendor purchase recorded.';

  res.status(201).json({
    success: true,
    message,
    data: purchase,
    createdProducts
  });
});

/**
 * Vendor/header details that are safe to correct on a purchase already
 * received into stock — typos, a missed vendor GSTIN, shipping info — without
 * touching stock or the accounting ledger. Mirrors EDITABLE_DETAIL_FIELDS in
 * routes/sales.js; items, amounts and payment fields are excluded on purpose,
 * see PURCHASE_LOCKED_FIELDS below.
 */
const PURCHASE_EDITABLE_DETAIL_FIELDS = [
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'vendorPhone', label: 'Vendor Phone' },
  { key: 'vendorGstin', label: 'Vendor GSTIN' },
  { key: 'vendorPan', label: 'Vendor PAN' },
  { key: 'vendorAddress', label: 'Vendor Address' },
  { key: 'vendorState', label: 'Vendor State' },
  { key: 'vendorStateCode', label: 'Vendor State Code' },
  { key: 'invoiceNo', label: 'Invoice No' },
  { key: 'notes', label: 'Notes' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'paymentRef', label: 'Payment Reference' },
  { key: 'paymentTerms', label: 'Payment Terms' },
  { key: 'termsOfDelivery', label: 'Terms of Delivery' },
  { key: 'placeOfSupply', label: 'Place of Supply' },
  { key: 'dispatchFrom', label: 'Dispatch From' },
  { key: 'dispatchDate', label: 'Dispatch Date' },
  { key: 'dispatchDocNo', label: 'Dispatch Doc No' },
  { key: 'shipToName', label: 'Ship To Name' },
  { key: 'shipToAddress', label: 'Ship To Address' },
  { key: 'vehicleNo', label: 'Vehicle No' },
  { key: 'shipBy', label: 'Ship By' },
  { key: 'transporterName', label: 'Transporter Name' },
  { key: 'buyerOrderNo', label: 'Buyer Order No' },
  { key: 'buyerOrderDate', label: 'Buyer Order Date' }
];

// Rejected outright on a details-only edit — these feed stock received at
// invoice cost or the ledger, so changing them here would desync inventory
// and the books from what was actually posted on receipt.
const PURCHASE_LOCKED_FIELDS = [
  'items', 'subtotal', 'tax', 'discount', 'roundOff', 'totalAmount', 'additionalCharges',
  'paymentMode', 'paymentStatus', 'paidAmount', 'settlementAccountId', 'status', 'vendorId', 'poId'
];

function logPurchaseEdit(store, purchase, changes, user) {
  if (!changes.length) return null;
  const now = new Date().toISOString();
  const entry = {
    id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    purchaseId: purchase.id,
    editedBy: user,
    editedAt: now,
    changes
  };

  if (!Array.isArray(store.purchaseEditLogs)) store.purchaseEditLogs = [];
  store.purchaseEditLogs.unshift(entry);
  if (store.purchaseEditLogs.length > 2000) store.purchaseEditLogs.pop();

  if (!Array.isArray(purchase.editHistory)) purchase.editHistory = [];
  purchase.editHistory.unshift(entry);

  purchase.isEdited = true;
  purchase.lastEditedAt = now;
  purchase.lastEditedBy = user;
  return entry;
}

/** Update a purchase invoice's vendor/header details only — items and amounts are locked once received. */
router.put('/purchases/:id', (req, res) => {
  const store = req.tenantStore;
  const purchase = (store.purchases || []).find((p) => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });

  if (purchase.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Voided purchases cannot be edited.' });
  }

  const lockedKeysPresent = PURCHASE_LOCKED_FIELDS.filter((k) => req.body[k] !== undefined);
  if (lockedKeysPresent.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Items and amounts on a received purchase can't be edited directly — void the purchase or raise a Return instead. (Blocked field${lockedKeysPresent.length > 1 ? 's' : ''}: ${lockedKeysPresent.join(', ')})`
    });
  }

  const changes = [];
  PURCHASE_EDITABLE_DETAIL_FIELDS.forEach(({ key, label }) => {
    if (req.body[key] === undefined) return;
    const oldValue = purchase[key] ?? '';
    const newValue = req.body[key] ?? '';
    if (String(oldValue) !== String(newValue)) {
      changes.push({ field: key, label, oldValue, newValue });
      purchase[key] = req.body[key];
    }
  });

  if (changes.length > 0) logPurchaseEdit(store, purchase, changes, actor(req));

  res.json({
    success: true,
    message: changes.length > 0 ? `Purchase ${purchase.invoiceNo} details updated.` : 'No changes to save.',
    data: purchase
  });
});

/**
 * Void a purchase invoice: pulls the received stock back out, reverses the
 * posted accounting voucher, and recomputes the vendor's payable — mirrors
 * how `/orders/:orderId/void` treats a sales bill. Purchases are never hard
 * deleted once posted, since that would silently break stock history and
 * the vendor ledger; voiding keeps a visible, reversible audit trail.
 */
router.post('/purchases/:id/void', (req, res) => {
  const store = req.tenantStore;
  const purchase = (store.purchases || []).find((p) => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (purchase.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'This purchase is already voided.' });
  }

  (purchase.items || []).forEach((line) => {
    const product = store.products.find((p) => p.id === line.productId);
    if (!product) return;
    // Reverse the same converted quantity that was actually added on receipt.
    const qty = baseQty(product, { unit: line.unit, qty: Number(line.qty) || 0 });

    if (product.trackBatches) {
      voidPurchaseBatches(product, purchase.id);
    } else {
      product.stock = r2(Number(product.stock || 0) - qty);
      if (product.warehouses && typeof product.warehouses === 'object') {
        const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
        product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) - qty);
        product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
      }
    }
    logStockMovement(store, {
      product,
      type: 'RETURN',
      qtyChange: -qty,
      reason: `Void of purchase ${purchase.invoiceNo}`,
      refId: purchase.id,
      user: actor(req)
    });
  });

  const reversed = [];
  (store.journal || [])
    .filter((v) => v.refId === purchase.id && !v.isReversed && !v.reversalOf)
    .forEach((v) => {
      try {
        reversed.push(engine.reverseJournal(store, v.id, actor(req)).voucherNo);
      } catch (err) {
        // "Already reversed" is expected when another voucher in this same
        // chain already reversed it — anything else is a real failure that
        // would otherwise leave stock restored but the ledger un-reversed
        // with no trace anywhere.
        if (err.message !== 'Voucher has already been reversed.') {
          console.error(`[Void purchase ${purchase.id}] Failed to reverse voucher ${v.id}:`, err.message);
        }
      }
    });

  if (purchase.vendorId) {
    const vendor = store.vendors.find((v) => v.id === purchase.vendorId);
    const account = (store.accounts || []).find((a) => a.partyId === purchase.vendorId && a.partyType === 'VENDOR');
    if (vendor && account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  }

  purchase.status = 'VOID';
  purchase.voidedBy = actor(req);
  purchase.voidedAt = new Date().toISOString();

  res.json({ success: true, message: `Purchase ${purchase.invoiceNo} voided.`, data: { purchase, reversed } });
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

  const settled = posting.applyVendorPaymentToPurchases(store, vendor, record.amount, discount);
  const totalApplied = settled.reduce((sum, s) => sum + (Number(s.applied) || 0), 0);
  const unapplied = r2(Math.max(0, (record.amount + r2(discount)) - totalApplied));

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
  if (account) {
    vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  } else {
    vendor.outstandingPayable = Math.max(0, (Number(vendor.outstandingPayable) || 0) - record.amount);
  }

  res.status(201).json({
    success: true,
    message: `Paid ₹${record.amount.toFixed(2)} to ${vendor.name} (${voucher.voucherNo}).`,
    data: {
      payment: record,
      settled,
      unapplied,
      outstandingPayable: vendor.outstandingPayable
    }
  });
});

/** Payments Made — every vendor payment recorded, independent of the ledger view. */
router.get('/vendors/payments', (req, res) => {
  const store = req.tenantStore;
  const { vendorId, from, to } = req.query;

  let rows = [...(store.payments || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (vendorId) rows = rows.filter((p) => p.vendorId === vendorId);
  if (from) rows = rows.filter((p) => engine.dayKey(p.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((p) => engine.dayKey(p.date) <= engine.dayKey(to));

  res.json({
    success: true,
    data: rows,
    summary: { count: rows.length, total: r2(rows.reduce((s, p) => s + (Number(p.amount) || 0), 0)) }
  });
});

/* -------------------------------- vendor credits (purchase returns) -------------------------------- */

/**
 * Vendor Credit — return part or all of a specific purchase back to its
 * supplier. Batch-tracked lines pull from the exact batch that purchase
 * created (traced via `line.batchId`, stamped on receipt); plain-stock lines
 * decrement `product.stock`/warehouse the same way a purchase void does.
 * Always posts a real reversing journal entry (Dr Vendor / Cr Inventory /
 * Cr GST Input) — unlike the older single-batch "return to supplier" inventory
 * action, this is never accounting-silent.
 */
router.post('/purchases/:id/return', (req, res) => {
  const store = req.tenantStore;
  const purchase = (store.purchases || []).find((p) => p.id === req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (purchase.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Cannot return items from a voided purchase.' });
  }
  if (!purchase.vendorId) {
    return res.status(400).json({ success: false, message: 'This purchase has no vendor to credit.' });
  }
  const vendor = store.vendors.find((v) => v.id === purchase.vendorId);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found.' });

  const { items, reason, date } = req.body;
  const requested = (Array.isArray(items) ? items : []).filter((l) => Number(l.qty) > 0);
  if (!requested.length) {
    return res.status(400).json({ success: false, message: 'Select at least one item to return.' });
  }

  // Kept in the purchase line's own unit (bags, boxes, whatever it was
  // received in) — same convention `purchase.items[].qty` already uses — so
  // it can be compared directly against `purchaseLine.qty` without a base-unit
  // detour. Only the actual stock/batch mutation below needs base units.
  const alreadyCredited = (productId, batchId) =>
    (store.vendorCredits || [])
      .filter((vc) => vc.purchaseId === purchase.id && vc.status !== 'VOID')
      .reduce(
        (sum, vc) =>
          sum +
          (vc.items || [])
            .filter((it) => it.productId === productId && (it.batchId || null) === (batchId || null))
            .reduce((s, it) => s + Number(it.qty || 0), 0),
        0
      );

  // Pass 1: validate every requested line before mutating anything, so a bad
  // line further down the list can't leave earlier lines half-applied.
  const plan = [];
  for (const reqLine of requested) {
    const qty = r2(Number(reqLine.qty));
    const purchaseLine = (purchase.items || []).find(
      (pl) => pl.productId === reqLine.productId && (pl.batchId || null) === (reqLine.batchId || null)
    );
    if (!purchaseLine) {
      return res.status(400).json({ success: false, message: `No matching line found on this purchase for the selected item.` });
    }
    const product = store.products.find((p) => p.id === reqLine.productId);
    if (!product) {
      return res.status(400).json({ success: false, message: `Product no longer exists in the catalogue.` });
    }

    const maxReturnable = r2(Number(purchaseLine.qty) - alreadyCredited(reqLine.productId, purchaseLine.batchId));
    const baseQtyToRemove = baseQty(product, { unit: purchaseLine.unit, qty });

    let batch = null;
    if (product.trackBatches) {
      if (!purchaseLine.batchId) {
        return res.status(400).json({ success: false, message: `${product.name}: original batch could not be traced on this purchase.` });
      }
      batch = product.batches.find((b) => b.id === purchaseLine.batchId);
      if (!batch) {
        return res.status(400).json({ success: false, message: `${product.name}: batch ${purchaseLine.batchNo || ''} no longer exists (already fully consumed/removed).` });
      }
    }
    const physicalCapBase = product.trackBatches ? Number(batch.qty) : Number(product.stock || 0);

    if (!(qty > 0) || qty > maxReturnable + 0.009 || baseQtyToRemove > physicalCapBase + 0.0001) {
      return res.status(400).json({
        success: false,
        message: `${product.name}: enter a quantity between 0 and ${r2(Math.min(maxReturnable, physicalCapBase))} ${purchaseLine.unit || ''} (already returned or sold reduces what's returnable).`
      });
    }

    plan.push({ product, purchaseLine, batch, qty, baseQtyToRemove });
  }

  // Pass 2: apply.
  const creditLines = [];
  plan.forEach(({ product, purchaseLine, batch, qty, baseQtyToRemove }) => {
    if (product.trackBatches) {
      writeOffBatch(product, batch.id, baseQtyToRemove, reason || 'Returned to supplier', actor(req));
    } else {
      product.stock = r2(Number(product.stock || 0) - baseQtyToRemove);
      if (product.warehouses && typeof product.warehouses === 'object') {
        const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
        product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) - baseQtyToRemove);
        product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
      }
    }

    logStockMovement(store, {
      product,
      type: 'RETURN',
      qtyChange: -baseQtyToRemove,
      reason: `Returned to supplier (${vendor.name}) — ${reason || 'Purchase Return'}`,
      refId: purchase.id,
      user: actor(req)
    });

    const lineSubtotal = r2(qty * Number(purchaseLine.rate || 0));
    const lineTax = r2((lineSubtotal * Number(purchaseLine.taxRate || 0)) / 100);
    creditLines.push({
      productId: product.id,
      productName: product.name,
      unit: purchaseLine.unit || product.unit,
      batchId: purchaseLine.batchId || null,
      batchNo: purchaseLine.batchNo || null,
      qty,
      baseQty: baseQtyToRemove,
      rate: Number(purchaseLine.rate || 0),
      taxRate: Number(purchaseLine.taxRate || 0),
      lineSubtotal,
      lineTax,
      lineTotal: r2(lineSubtotal + lineTax)
    });
  });

  const subtotal = r2(creditLines.reduce((s, l) => s + l.lineSubtotal, 0));
  const tax = r2(creditLines.reduce((s, l) => s + l.lineTax, 0));
  const totalAmount = r2(subtotal + tax);

  const vendorCredit = {
    id: `vc_${Date.now()}`,
    vendorId: vendor.id,
    vendorName: vendor.name,
    purchaseId: purchase.id,
    purchaseInvoiceNo: purchase.invoiceNo,
    date: date || new Date().toISOString(),
    reason: reason || 'Purchase Return',
    items: creditLines,
    subtotal,
    tax,
    totalAmount,
    status: 'ACTIVE',
    createdBy: actor(req),
    createdAt: new Date().toISOString()
  };

  try {
    const voucher = posting.postPurchaseReturn(store, vendorCredit, {
      vendor,
      interState: store.settings.tax.interState,
      createdBy: actor(req)
    });
    vendorCredit.voucherId = voucher.id;
    vendorCredit.voucherNo = voucher.voucherNo;
  } catch (err) {
    vendorCredit.accountingError = err.message;
  }

  const account = (store.accounts || []).find((a) => a.partyId === vendor.id && a.partyType === 'VENDOR');
  if (account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));

  if (!Array.isArray(store.vendorCredits)) store.vendorCredits = [];
  store.vendorCredits.unshift(vendorCredit);

  res.status(201).json({
    success: true,
    message: `Returned ${creditLines.length} item(s) to ${vendor.name}. Credited ₹${totalAmount.toFixed(2)}.`,
    data: vendorCredit
  });
});

router.get('/vendor-credits', (req, res) => {
  const store = req.tenantStore;
  const { vendorId, purchaseId, from, to } = req.query;

  let rows = [...(store.vendorCredits || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (vendorId) rows = rows.filter((v) => v.vendorId === vendorId);
  if (purchaseId) rows = rows.filter((v) => v.purchaseId === purchaseId);
  if (from) rows = rows.filter((v) => engine.dayKey(v.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((v) => engine.dayKey(v.date) <= engine.dayKey(to));

  const active = rows.filter((v) => v.status !== 'VOID');

  res.json({
    success: true,
    data: rows,
    summary: { count: active.length, total: r2(active.reduce((s, v) => s + (Number(v.totalAmount) || 0), 0)) }
  });
});

/** Voids a vendor credit: restores the returned stock/batch and reverses the journal entry. */
router.post('/vendor-credits/:id/void', (req, res) => {
  const store = req.tenantStore;
  const vc = (store.vendorCredits || []).find((v) => v.id === req.params.id);
  if (!vc) return res.status(404).json({ success: false, message: 'Vendor credit not found.' });
  if (vc.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'This vendor credit is already voided.' });
  }

  (vc.items || []).forEach((line) => {
    const product = store.products.find((p) => p.id === line.productId);
    if (!product) return;
    // `line.qty` is in the original purchase line's unit (bags, boxes, …) for
    // display; stock/batches are tracked in base units, so restoration must
    // use the base-unit amount actually removed, not the display quantity.
    const qty = Number(line.baseQty ?? line.qty) || 0;

    if (product.trackBatches && line.batchId) {
      const batch = product.batches.find((b) => b.id === line.batchId);
      if (batch) {
        batch.qty = r2(Number(batch.qty) + qty);
      } else {
        product.batches.push({
          id: `batch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          batchNo: line.batchNo || 'RESTORED',
          mfgDate: null,
          expiryDate: null,
          qty,
          costPrice: Number(line.rate) || 0,
          sellPrice: null,
          refPurchaseId: vc.purchaseId,
          warehouseId: 'wh_main',
          source: 'restored',
          createdAt: new Date().toISOString()
        });
      }
      product.stock = r2((product.batches || []).reduce((s, b) => s + (Number(b.qty) || 0), 0));
    } else {
      product.stock = r2(Number(product.stock || 0) + qty);
      if (product.warehouses && typeof product.warehouses === 'object') {
        const whKey = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
        product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) + qty);
        product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
      }
    }

    logStockMovement(store, {
      product,
      type: 'PURCHASE',
      qtyChange: qty,
      reason: `Void of return to supplier — ${vc.purchaseInvoiceNo || ''}`,
      refId: vc.id,
      user: actor(req)
    });
  });

  (store.journal || [])
    .filter((v) => v.refId === vc.id && !v.isReversed && !v.reversalOf)
    .forEach((v) => {
      try {
        engine.reverseJournal(store, v.id, actor(req));
      } catch (err) {
        if (err.message !== 'Voucher has already been reversed.') {
          console.error(`[Void vendor credit ${vc.id}] Failed to reverse voucher ${v.id}:`, err.message);
        }
      }
    });

  if (vc.vendorId) {
    const vendor = store.vendors.find((v) => v.id === vc.vendorId);
    const account = (store.accounts || []).find((a) => a.partyId === vc.vendorId && a.partyType === 'VENDOR');
    if (vendor && account) vendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  }

  vc.status = 'VOID';
  vc.voidedBy = actor(req);
  vc.voidedAt = new Date().toISOString();

  res.json({ success: true, message: 'Vendor credit voided; returned stock restored.', data: vc });
});

/* -------------------------------- purchase orders -------------------------------- */

router.get('/purchase-orders', (req, res) => {
  const store = req.tenantStore;
  const { vendorId, status, from, to } = req.query;

  let rows = [...(store.purchaseOrders || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (vendorId) rows = rows.filter((p) => p.vendorId === vendorId);
  if (status && status !== 'ALL') rows = rows.filter((p) => p.status === status);
  if (from) rows = rows.filter((p) => engine.dayKey(p.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((p) => engine.dayKey(p.date) <= engine.dayKey(to));

  res.json({
    success: true,
    data: rows,
    summary: {
      open: rows.filter((p) => p.status === 'ISSUED' || p.status === 'PARTIALLY_RECEIVED').length,
      totalOpenValue: r2(
        rows
          .filter((p) => p.status === 'ISSUED' || p.status === 'PARTIALLY_RECEIVED')
          .reduce((s, p) => s + (Number(p.totalAmount) || 0), 0)
      )
    }
  });
});

/**
 * Creates a purchase order — a commitment to a vendor before anything has
 * been received. No stock or accounting moves yet; that only happens when a
 * purchase is later recorded against it via `POST /purchases` with `poId`.
 */
router.post('/purchase-orders', (req, res) => {
  const store = req.tenantStore;
  const { vendorId, vendorName, items, expectedDate, notes, date } = req.body;

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
  if (!vendor) {
    return res.status(400).json({ success: false, message: 'Select or enter a vendor for this purchase order.' });
  }

  const lines = Array.isArray(items) ? items : [];
  const shapedItems = lines
    .map((line) => {
      const product = store.products.find((p) => p.id === line.productId);
      return {
        productId: line.productId || null,
        productName: line.productName || product?.name || 'Item',
        unit: line.unit || product?.unit || 'pcs',
        hsn: line.hsn || product?.hsn || '',
        taxRate: Number(line.taxRate ?? product?.taxRate ?? 0),
        orderedQty: Number(line.qty) || 0,
        receivedQty: 0,
        rate: Number(line.rate) || 0
      };
    })
    .filter((l) => l.productId && l.orderedQty > 0);

  if (!shapedItems.length) {
    return res.status(400).json({ success: false, message: 'Add at least one catalogue item with a quantity to the purchase order.' });
  }

  const subtotal = r2(shapedItems.reduce((s, l) => s + l.orderedQty * l.rate, 0));
  const tax = r2(shapedItems.reduce((s, l) => s + (l.orderedQty * l.rate * l.taxRate) / 100, 0));
  const totalAmount = r2(subtotal + tax);

  store.voucherCounters.PO = (store.voucherCounters.PO || 0) + 1;
  const poNumber = `PO-${String(store.voucherCounters.PO).padStart(5, '0')}`;

  const po = {
    id: `po_${Date.now()}`,
    poNumber,
    vendorId: vendor.id,
    vendorName: vendor.name,
    date: date || new Date().toISOString(),
    expectedDate: expectedDate || null,
    items: shapedItems,
    subtotal,
    tax,
    totalAmount,
    status: 'ISSUED',
    notes: notes || '',
    createdBy: actor(req),
    createdAt: new Date().toISOString(),
    purchaseIds: []
  };

  if (!Array.isArray(store.purchaseOrders)) store.purchaseOrders = [];
  store.purchaseOrders.unshift(po);

  res.status(201).json({ success: true, message: `Purchase order ${poNumber} created for ${vendor.name}.`, data: po });
});

router.post('/purchase-orders/:id/cancel', (req, res) => {
  const store = req.tenantStore;
  const po = (store.purchaseOrders || []).find((p) => p.id === req.params.id);
  if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found.' });
  if (po.status === 'CANCELLED') return res.status(400).json({ success: false, message: 'Already cancelled.' });
  if ((po.items || []).some((l) => l.receivedQty > 0)) {
    return res.status(400).json({
      success: false,
      message: 'This purchase order already has receipts recorded against it. Cancel is only allowed before anything has been received.'
    });
  }

  po.status = 'CANCELLED';
  po.cancelledBy = actor(req);
  po.cancelledAt = new Date().toISOString();

  res.json({ success: true, message: `Purchase order ${po.poNumber} cancelled.`, data: po });
});

module.exports = router;
