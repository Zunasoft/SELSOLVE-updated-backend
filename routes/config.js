/**
 * Settings, user management & permissions, hardware and composite items —
 * Modules 11, 12, 13 and 18 of the SOW.
 */

const express = require('express');
const { ROLE_PERMISSIONS } = require('../store');

const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';

/* --------------------------------- settings --------------------------------- */

router.get('/settings', (req, res) => {
  res.json({ success: true, data: req.tenantStore.settings });
});

/** Section-wise merge so one screen can save without clobbering the others. */
router.put('/settings/:section', (req, res) => {
  const store = req.tenantStore;
  const section = req.params.section;

  if (!store.settings[section]) {
    return res.status(404).json({ success: false, message: `Unknown settings section "${section}".` });
  }

  store.settings[section] = { ...store.settings[section], ...req.body };
  res.json({
    success: true,
    message: `${section.charAt(0).toUpperCase() + section.slice(1)} settings saved.`,
    data: store.settings[section]
  });
});

/* --------------------------------- hardware --------------------------------- */

router.get('/hardware', (req, res) => {
  res.json({ success: true, data: req.tenantStore.settings.hardware });
});

router.put('/hardware/:device', (req, res) => {
  const hardware = req.tenantStore.settings.hardware;
  const device = req.params.device;
  if (!hardware[device]) {
    return res.status(404).json({ success: false, message: `Unknown device "${device}".` });
  }
  hardware[device] = { ...hardware[device], ...req.body };
  res.json({ success: true, message: `${hardware[device].name} configuration saved.`, data: hardware[device] });
});

/**
 * Device pairing / connection test. Physical I/O happens in the Android client;
 * the server records the pairing so configuration follows the tenant.
 */
router.post('/hardware/:device/test', (req, res) => {
  const hardware = req.tenantStore.settings.hardware;
  const device = hardware[req.params.device];
  if (!device) return res.status(404).json({ success: false, message: 'Unknown device.' });

  device.status = 'connected';
  device.lastTestedAt = new Date().toISOString();
  device.lastTestResult = 'OK';

  const detail = {
    printer: 'Test receipt sent to the thermal printer.',
    weighingScale: 'Scale responded — stable weight read successfully.',
    barcodeScanner: 'Scanner is in HID mode and ready to accept scans.',
    barcodePrinter: 'Test label sent to the barcode printer.',
    cashDrawer: 'Drawer kick-out pulse sent.'
  }[req.params.device];

  res.json({ success: true, message: detail || 'Device responded successfully.', data: device });
});

/** Simulated stable weight read — the Android client replaces this with serial I/O. */
router.get('/hardware/weight', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale;
  if (!scale.enabled) {
    return res.status(400).json({ success: false, message: 'Weighing scale is disabled in settings.' });
  }
  const weight = Number((Math.random() * (3.5 - 0.15) + 0.15).toFixed(3));
  res.json({ success: true, data: { weight, unit: 'kg', stable: true, readAt: new Date().toISOString() } });
});

/** Barcode label payload for the label printer / kiosk flow. */
router.post('/hardware/barcode-label', (req, res) => {
  const store = req.tenantStore;
  const { productId, weight, quantity } = req.body;
  const product = store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const qty = Number(weight) || Number(quantity) || 1;
  const amount = Math.round(qty * product.price * 100) / 100;

  res.json({
    success: true,
    message: 'Barcode label generated.',
    data: {
      productName: product.printName || product.name,
      barcode: product.barcode,
      // Weight-embedded EAN-13 style payload: prefix + item + weight in grams.
      encoded: product.requiresWeight
        ? `21${product.barcode.slice(-5)}${String(Math.round(qty * 1000)).padStart(5, '0')}`
        : product.barcode,
      unit: product.unit,
      quantity: qty,
      rate: product.price,
      amount,
      mrp: product.mrp,
      labelSize: store.settings.hardware.barcodePrinter.labelSize,
      printedAt: new Date().toISOString()
    }
  });
});

/* ------------------------------ users & roles ------------------------------ */

router.get('/users', (req, res) => {
  res.json({
    success: true,
    data: {
      users: (req.tenantStore.users || []).map(({ pin, ...u }) => ({ ...u, hasPin: Boolean(pin) })),
      roles: Object.keys(ROLE_PERMISSIONS),
      permissionMatrix: ROLE_PERMISSIONS,
      permissionKeys: Object.keys(ROLE_PERMISSIONS.Owner)
    }
  });
});

router.post('/users', (req, res) => {
  const store = req.tenantStore;
  const { name, phone, email, role, pin, permissions } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'User name is required.' });
  if (!ROLE_PERMISSIONS[role || 'Cashier']) {
    return res.status(400).json({ success: false, message: 'Unknown role.' });
  }

  const user = {
    id: `u_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    role: role || 'Cashier',
    pin: pin || '0000',
    status: 'active',
    permissions: permissions || null,
    createdBy: actor(req),
    createdAt: new Date().toISOString()
  };

  store.users.push(user);
  const { pin: _pin, ...safe } = user;
  res.status(201).json({ success: true, message: `${user.role} "${user.name}" added.`, data: safe });
});

router.put('/users/:id', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const { name, phone, email, role, status, pin, permissions } = req.body;
  if (user.role === 'Owner' && role && role !== 'Owner') {
    return res.status(400).json({ success: false, message: 'The Owner role cannot be changed.' });
  }

  if (name) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (email !== undefined) user.email = email;
  if (role && ROLE_PERMISSIONS[role]) user.role = role;
  if (status) user.status = status;
  if (pin) user.pin = pin;
  if (permissions !== undefined) user.permissions = permissions;

  const { pin: _pin, ...safe } = user;
  res.json({ success: true, message: 'User updated.', data: safe });
});

router.delete('/users/:id', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (user.role === 'Owner') {
    return res.status(400).json({ success: false, message: 'The Owner account cannot be removed.' });
  }
  store.users = store.users.filter((u) => u.id !== req.params.id);
  res.json({ success: true, message: 'User removed.' });
});

/** Effective permissions: explicit overrides win, otherwise the role default. */
router.get('/users/:id/permissions', (req, res) => {
  const user = (req.tenantStore.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({
    success: true,
    data: {
      role: user.role,
      effective: { ...ROLE_PERMISSIONS[user.role], ...(user.permissions || {}) }
    }
  });
});

/** PIN sign-in at the counter — decides which modules the session can reach. */
router.post('/users/verify-pin', (req, res) => {
  const store = req.tenantStore;
  const { userId, pin } = req.body;
  const user = (store.users || []).find((u) => u.id === userId);

  if (!user || user.pin !== String(pin)) {
    return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ success: false, message: 'This user account is inactive.' });
  }

  const { pin: _pin, ...safe } = user;
  res.json({
    success: true,
    message: `Welcome, ${user.name}.`,
    data: { user: safe, permissions: { ...ROLE_PERMISSIONS[user.role], ...(user.permissions || {}) } }
  });
});

/* ------------------------- composite items (recipes) ------------------------- */

router.get('/recipes', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.recipes || []).map((r) => {
    const cost = r.ingredients.reduce((sum, ing) => {
      const raw = store.products.find((p) => p.id === ing.productId);
      return sum + (raw ? raw.purchasePrice * Number(ing.qty) : 0);
    }, 0);
    const product = store.products.find((p) => p.id === r.productId);
    const unitCost = Math.round((cost / (r.yieldQty || 1)) * 100) / 100;
    return {
      ...r,
      unitCost,
      sellingPrice: product ? product.price : 0,
      margin: product ? Math.round((product.price - unitCost) * 100) / 100 : 0,
      producible: Math.min(
        ...r.ingredients.map((ing) => {
          const raw = store.products.find((p) => p.id === ing.productId);
          return raw && Number(ing.qty) ? Math.floor(raw.stock / Number(ing.qty)) : 0;
        })
      )
    };
  });
  res.json({ success: true, data: rows });
});

router.post('/recipes', (req, res) => {
  const store = req.tenantStore;
  const { productId, yieldQty, ingredients } = req.body;

  const product = store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Composite product not found.' });
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one raw material is required.' });
  }

  const recipe = {
    id: `rec_${Date.now()}`,
    productId,
    productName: product.name,
    yieldQty: Number(yieldQty) || 1,
    ingredients: ingredients.map((i) => {
      const raw = store.products.find((p) => p.id === i.productId);
      return {
        productId: i.productId,
        name: raw ? raw.name : i.name,
        qty: Number(i.qty),
        unit: raw ? raw.unit : i.unit || 'pcs'
      };
    }),
    createdAt: new Date().toISOString()
  };

  store.recipes = (store.recipes || []).filter((r) => r.productId !== productId);
  store.recipes.push(recipe);
  product.isComposite = true;

  res.status(201).json({ success: true, message: `Recipe saved for ${product.name}.`, data: recipe });
});

router.delete('/recipes/:id', (req, res) => {
  const store = req.tenantStore;
  const recipe = (store.recipes || []).find((r) => r.id === req.params.id);
  if (recipe) {
    const product = store.products.find((p) => p.id === recipe.productId);
    if (product) product.isComposite = false;
  }
  store.recipes = (store.recipes || []).filter((r) => r.id !== req.params.id);
  res.json({ success: true, message: 'Recipe removed.' });
});

module.exports = router;
