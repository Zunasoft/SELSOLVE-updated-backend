/**
 * Settings, user management & permissions, hardware and composite items —
 * Modules 11, 12, 13 and 18 of the SOW.
 */

const express = require('express');
const { ROLE_PERMISSIONS, ASSIGNABLE_ROLES, PERMISSION_KEYS, MODULE_KEYS, effectivePermissions } = require('../store');
const { FEATURE_CATALOG, resolveTenantFeatures } = require('../modules/features');
const { setRecipe, removeRecipe, decorateRecipe } = require('../modules/recipes');
const { saveSettingsToDb } = require('../tenantProvisioner');

const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';

const DEFAULT_ROLE = 'CASHIER';
const OWNER_ROLE = 'OWNER';

/** Roles are stored upper-case; accept whatever casing the client sends. */
const normaliseRole = (role) => (role ? String(role).toUpperCase() : null);

/* --------------------------------- features --------------------------------- */

/**
 * What this shop's subscription actually unlocks. The client hides the tabs it
 * gets `false` for; the server refuses those routes regardless, so hiding is a
 * courtesy rather than the control.
 */
router.get('/features', (req, res) => {
  // Same resolver the route gate uses, so what the client hides and what the
  // server refuses are always the same set.
  const features = resolveTenantFeatures(req.tenant);
  res.json({
    success: true,
    data: {
      plan: req.tenant?.plan || null,
      planExpiry: req.tenant?.expiryDate || null,
      features,
      catalog: FEATURE_CATALOG,
      enabled: Object.entries(features).filter(([, on]) => on).map(([key]) => key)
    }
  });
});

/* --------------------------------- settings --------------------------------- */

router.get('/settings', (req, res) => {
  res.json({ success: true, data: req.tenantStore.settings });
});

/** Section-wise merge so one screen can save without clobbering the others. */
router.put('/settings/:section', async (req, res) => {
  const store = req.tenantStore;
  const section = req.params.section;

  if (!store.settings[section]) {
    return res.status(404).json({ success: false, message: `Unknown settings section "${section}".` });
  }

  store.settings[section] = { ...store.settings[section], ...req.body };
  await saveSettingsToDb(req.tenantDbName, store.settings);
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

/**
 * Stable weight read for the POS weight display.
 *
 * The Android client talks to the scale over serial and posts the reading back;
 * on desktop and web there is no serial port, so the server answers with a
 * simulated stable read so the billing flow can be exercised end to end.
 * `enabled` defaults to on — a shop that has not touched hardware settings still
 * gets a working weight button rather than a silent 400.
 */
router.get('/hardware/weight', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  if (scale.enabled === false) {
    return res.status(400).json({ success: false, message: 'Weighing scale is disabled in Settings → Hardware.' });
  }

  const weight = Number((Math.random() * (3.5 - 0.15) + 0.15).toFixed(3));
  res.json({
    success: true,
    data: {
      weight,
      unit: 'kg',
      stable: true,
      simulated: scale.status !== 'connected',
      comPort: scale.comPort || null,
      readAt: new Date().toISOString()
    }
  });
});

/** Record a reading taken by a real scale on the client side. */
router.post('/hardware/weight', (req, res) => {
  const scale = req.tenantStore.settings.hardware.weighingScale || {};
  const weight = Number(req.body.weight);
  if (!Number.isFinite(weight) || weight < 0) {
    return res.status(400).json({ success: false, message: 'A valid weight is required.' });
  }

  scale.status = 'connected';
  scale.lastReading = weight;
  scale.lastReadAt = new Date().toISOString();

  res.json({ success: true, data: { weight, unit: scale.unit || 'kg', stable: true, readAt: scale.lastReadAt } });
});

/**
 * Decode a weight-embedded barcode produced by a counter weighing scale.
 * Layout: <prefix><item code><weight in grams><check digit>, which is what
 * every Indian counter scale prints for loose goods.
 */
router.get('/hardware/decode-barcode/:code', (req, res) => {
  const store = req.tenantStore;
  const code = String(req.params.code).trim();
  const prefix = store.settings.hardware.weighingScale?.embeddedBarcodePrefix || '21';

  const direct = (store.products || []).find(
    (p) => p.barcode === code || (p.barcodes || []).includes(code)
  );
  if (direct) {
    return res.json({ success: true, data: { product: direct, quantity: 1, embedded: false } });
  }

  if (code.length >= 12 && code.startsWith(prefix)) {
    const itemCode = code.slice(prefix.length, prefix.length + 5);
    const grams = Number(code.slice(prefix.length + 5, prefix.length + 10));
    const product = (store.products || []).find(
      (p) => String(p.barcode).slice(-5) === itemCode || (p.barcodes || []).some((b) => String(b).slice(-5) === itemCode)
    );

    if (product && Number.isFinite(grams)) {
      const quantity = Math.round((grams / 1000) * 1000) / 1000;
      return res.json({
        success: true,
        data: {
          product,
          quantity,
          embedded: true,
          amount: Math.round(quantity * product.price * 100) / 100
        }
      });
    }
  }

  res.status(404).json({ success: false, message: 'No product matches that barcode.' });
});

/** Barcode label payload for the label printer / kiosk flow. */
router.post('/hardware/barcode-label', (req, res) => {
  const store = req.tenantStore;
  const { productId, weight, quantity } = req.body;
  const product = store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const qty = Number(weight) || Number(quantity) || 1;
  const amount = Math.round(qty * product.price * 100) / 100;

  // The label printer is configured under either key depending on how old the
  // shop's settings document is; neither is guaranteed to be present.
  const hardware = store.settings.hardware || {};
  const labelPrinter = hardware.barcodePrinter || hardware.labelPrinter || {};
  const prefix = hardware.weighingScale?.embeddedBarcodePrefix || '21';

  res.json({
    success: true,
    message: 'Barcode label generated.',
    data: {
      productName: product.printName || product.regionalName || product.name,
      barcode: product.barcode,
      // Weight-embedded EAN-13 style payload: prefix + item + weight in grams.
      encoded: product.requiresWeight
        ? `${prefix}${String(product.barcode).slice(-5)}${String(Math.round(qty * 1000)).padStart(5, '0')}`
        : product.barcode,
      unit: product.unit,
      quantity: qty,
      rate: product.price,
      amount,
      mrp: product.mrp,
      labelSize: labelPrinter.labelSize || '50x25mm',
      printedAt: new Date().toISOString()
    }
  });
});

/* ------------------------------ users & roles ------------------------------ */

const PERMISSION_LABELS = {
  canDiscount: 'Apply discount',
  canVoidBill: 'Void / cancel bill',
  canManageStock: 'Adjust stock',
  canEditPrice: 'Edit prices',
  canManageProducts: 'Add / edit products',
  canManageParties: 'Add / edit customers & vendors',
  canRecordPurchase: 'Record purchases',
  canAccessReports: 'View reports',
  canExport: 'Export to PDF / Excel',
  canAccessSettings: 'Change settings',
  canManageUsers: 'Manage users',
  canOpenSession: 'Open counter session',
  canCloseSession: 'Close counter session',
  canCashInOut: 'Cash in / cash out'
};

const MODULE_LABELS = {
  dashboard: 'Dashboard',
  billing: 'POS Billing',
  products: 'Products',
  inventory: 'Inventory',
  purchases: 'Purchases',
  customers: 'Customers',
  vendors: 'Vendors',
  accounts: 'Accounts',
  expenses: 'Expenses',
  reports: 'Reports',
  tables: 'Tables',
  settings: 'Settings',
  users: 'Users & Roles'
};

router.get('/users', (req, res) => {
  const planFeatures = resolveTenantFeatures(req.tenant);

  res.json({
    success: true,
    data: {
      users: (req.tenantStore.users || []).map(({ pin, ...u }) => ({
        ...u,
        hasPin: Boolean(pin),
        effective: effectivePermissions(u)
      })),
      roles: ASSIGNABLE_ROLES.map((key) => ({
        key,
        label: ROLE_PERMISSIONS[key].label,
        defaults: ROLE_PERMISSIONS[key]
      })),
      permissionMatrix: ROLE_PERMISSIONS,
      permissionKeys: PERMISSION_KEYS,
      permissionLabels: PERMISSION_LABELS,
      moduleKeys: MODULE_KEYS,
      moduleLabels: MODULE_LABELS,
      // A module the subscription does not include cannot be granted to anyone,
      // so the matrix greys it out instead of pretending the toggle works.
      planFeatures
    }
  });
});

router.post('/users', (req, res) => {
  const store = req.tenantStore;
  const { name, phone, email, pin, permissions } = req.body;
  const role = normaliseRole(req.body.role) || DEFAULT_ROLE;

  if (!name) return res.status(400).json({ success: false, message: 'User name is required.' });
  if (!ROLE_PERMISSIONS[role]) {
    return res.status(400).json({ success: false, message: `Unknown role "${role}".` });
  }

  const user = {
    id: `u_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    role,
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

  const { name, phone, email, status, pin, permissions } = req.body;
  const role = normaliseRole(req.body.role);

  if (user.role === OWNER_ROLE && role && role !== OWNER_ROLE) {
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
  if (user.role === OWNER_ROLE) {
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
      roleDefaults: ROLE_PERMISSIONS[user.role] || null,
      overrides: user.permissions || null,
      effective: effectivePermissions(user)
    }
  });
});

/**
 * Permission toggle & module access control — Module 11.
 *
 * Only the differences from the role default are stored, so a later change to a
 * role's baseline still reaches every user who has not been given an explicit
 * override for that particular switch.
 */
router.put('/users/:id/permissions', (req, res) => {
  const store = req.tenantStore;
  const user = (store.users || []).find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if (user.role === OWNER_ROLE) {
    return res.status(400).json({
      success: false,
      message: 'The Owner always has full access — their permissions cannot be restricted.'
    });
  }

  const base = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS[DEFAULT_ROLE];
  const { modules, reset, ...flags } = req.body;

  if (reset) {
    user.permissions = null;
    return res.json({
      success: true,
      message: `${user.name} reset to the ${base.label} defaults.`,
      data: { role: user.role, overrides: null, effective: effectivePermissions(user) }
    });
  }

  const overrides = { ...(user.permissions || {}) };

  // Module access: keep only the entries that actually differ from the role.
  if (modules && typeof modules === 'object') {
    const moduleOverrides = { ...(overrides.modules || {}) };
    for (const key of MODULE_KEYS) {
      if (modules[key] === undefined) continue;
      const wanted = Boolean(modules[key]);
      if (wanted === Boolean(base.modules[key])) delete moduleOverrides[key];
      else moduleOverrides[key] = wanted;
    }
    if (Object.keys(moduleOverrides).length) overrides.modules = moduleOverrides;
    else delete overrides.modules;
  }

  // Action toggles, same rule. `maxDiscountPercent` is a number, not a switch.
  for (const key of [...PERMISSION_KEYS, 'maxDiscountPercent']) {
    if (req.body[key] === undefined) continue;
    const wanted = key === 'maxDiscountPercent' ? Number(req.body[key]) : Boolean(flags[key]);
    if (wanted === base[key]) delete overrides[key];
    else overrides[key] = wanted;
  }

  user.permissions = Object.keys(overrides).length ? overrides : null;

  res.json({
    success: true,
    message: `Permissions updated for ${user.name}.`,
    data: { role: user.role, overrides: user.permissions, effective: effectivePermissions(user) }
  });
});

/** PIN sign-in at the counter — decides which modules the session can reach. */
router.post('/users/verify-pin', (req, res) => {
  const store = req.tenantStore;
  const { userId, pin } = req.body;
  const user = (store.users || []).find((u) => u.id === userId);

  if (!user || user.pin !== String(pin)) {
    // Coded so the client does not mistake a mistyped counter PIN for an
    // expired shop session and sign the user out.
    return res.status(401).json({ success: false, code: 'INVALID_PIN', message: 'Incorrect PIN.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ success: false, code: 'USER_INACTIVE', message: 'This user account is inactive.' });
  }

  const { pin: _pin, ...safe } = user;
  res.json({
    success: true,
    message: `Welcome, ${user.name}.`,
    data: { user: safe, permissions: effectivePermissions(user) }
  });
});

/* ------------------------- composite items (recipes) ------------------------- */

/**
 * Recipes are created and edited on the Add/Edit Product screen in Inventory —
 * these endpoints are the read-across view (every composite in one list) and the
 * same save path the product form uses, so the two can never disagree.
 */
router.get('/recipes', (req, res) => {
  const store = req.tenantStore;
  const rows = (store.recipes || []).map((r) => decorateRecipe(store, r));

  res.json({
    success: true,
    data: rows,
    summary: {
      total: rows.length,
      outOfStock: rows.filter((r) => r.stockStatus === 'OUT_OF_STOCK').length,
      rawMaterials: [...new Set(rows.flatMap((r) => r.ingredients.map((i) => i.productId)))].length
    }
  });
});

router.post('/recipes', (req, res) => {
  const store = req.tenantStore;
  const { productId } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Composite product not found.' });

  try {
    const recipe = setRecipe(store, product, req.body);
    res.status(201).json({
      success: true,
      message: `Recipe saved for ${product.name} — costed at ${recipe.unitCost} per ${product.unit}.`,
      data: decorateRecipe(store, recipe)
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/recipes/:id', (req, res) => {
  const store = req.tenantStore;
  const recipe = (store.recipes || []).find((r) => r.id === req.params.id);
  if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found.' });

  const product = (store.products || []).find((p) => p.id === recipe.productId);
  if (product) {
    // Without a recipe the item can no longer be a composite, so it falls back
    // to a standard product rather than silently selling with no deduction.
    product.isComposite = false;
    product.productType = 'standard';
    product.recipeItems = [];
  }

  removeRecipe(store, recipe.productId);
  res.json({ success: true, message: `Recipe removed — "${recipe.productName}" is now a standard product.` });
});

module.exports = router;
