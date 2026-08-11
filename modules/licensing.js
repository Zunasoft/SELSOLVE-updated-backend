/**
 * Device management, subscriptions and Razorpay payments —
 * SOW Modules 1 (Device Management, Plan Management) and 14 (Payment Gateway).
 */

const express = require('express');
const crypto = require('crypto');
const { memoryDb, addAuditLog } = require('../db');

const router = express.Router();

const actorOf = (req) => req.admin?.email || 'SuperAdmin';
const iso = () => new Date().toISOString();
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 * Collections
 * ------------------------------------------------------------------ */

function ensureCollections() {
  if (!Array.isArray(memoryDb.devices)) memoryDb.devices = [];
  if (!Array.isArray(memoryDb.subscriptions)) memoryDb.subscriptions = [];
  if (!Array.isArray(memoryDb.payments)) memoryDb.payments = [];

  memoryDb.plans.forEach((plan) => {
    // Widen any pre-catalogue feature list before it is read as a denial.
    upgradePlanFeatures(plan);
    if (!plan.licenseModel) plan.licenseModel = plan.id === 'enterprise' ? 'PER_ORGANISATION' : 'PER_DEVICE';
    if (!plan.billingCycle) plan.billingCycle = 'Monthly';
    if (plan.trialDays === undefined) plan.trialDays = plan.id === 'starter' ? 14 : 0;
    if (plan.isActive === undefined) plan.isActive = true;
  });
}

router.use((req, res, next) => {
  ensureCollections();
  next();
});

const findTenant = (id) => memoryDb.tenants.find((t) => t.id === id || t.tenantId === id);

const planOf = (tenant) => memoryDb.plans.find((p) => p.id === tenant.plan) || null;

function licenceUsage(tenant) {
  const plan = planOf(tenant);
  const devices = memoryDb.devices.filter((d) => d.tenantId === tenant.tenantId);
  const active = devices.filter((d) => d.status === 'active');
  const model = plan?.licenseModel || 'PER_DEVICE';

  return {
    model,
    seats: model === 'PER_ORGANISATION' ? null : tenant.maxDevices,
    used: active.length,
    available: model === 'PER_ORGANISATION' ? null : Math.max(0, tenant.maxDevices - active.length),
    registered: devices.length,
    blocked: devices.filter((d) => d.status === 'blocked').length
  };
}

const daysUntil = (date) => Math.ceil((new Date(date) - new Date()) / 86400000);

function subscriptionState(tenant) {
  const remaining = daysUntil(tenant.expiryDate);
  return {
    plan: tenant.plan,
    planName: planOf(tenant)?.name || tenant.plan,
    expiryDate: tenant.expiryDate,
    daysRemaining: remaining,
    status:
      tenant.status !== 'active'
        ? 'SUSPENDED'
        : remaining < 0
          ? 'EXPIRED'
          : remaining <= 7
            ? 'EXPIRING_SOON'
            : 'ACTIVE',
    isTrial: Boolean(tenant.isTrial)
  };
}

/* ------------------------------------------------------------------ *
 * Device management
 * ------------------------------------------------------------------ */

router.get('/devices', (req, res) => {
  const { tenantId, status } = req.query;

  let rows = memoryDb.devices;
  if (tenantId) rows = rows.filter((d) => d.tenantId === tenantId);
  if (status && status !== 'ALL') rows = rows.filter((d) => d.status === status);

  res.json({
    success: true,
    data: {
      devices: rows.map((d) => {
        const tenant = memoryDb.tenants.find((t) => t.tenantId === d.tenantId);
        return { ...d, shopName: tenant ? tenant.name : '—' };
      }),
      summary: {
        total: memoryDb.devices.length,
        active: memoryDb.devices.filter((d) => d.status === 'active').length,
        blocked: memoryDb.devices.filter((d) => d.status === 'blocked').length,
        online: memoryDb.devices.filter((d) => d.lastSeenAt && daysUntil(d.lastSeenAt) > -1).length
      },
      licences: memoryDb.tenants.map((t) => ({
        tenantId: t.tenantId,
        shopName: t.name,
        plan: t.plan,
        ...licenceUsage(t)
      }))
    }
  });
});

router.post('/devices', (req, res) => {
  const { tenantId, deviceName, deviceId, model, androidVersion, appVersion } = req.body;

  const tenant = findTenant(tenantId);
  if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });
  if (!deviceName) return res.status(400).json({ success: false, message: 'Device name is required.' });

  const hardwareId = deviceId || `dev-${crypto.randomBytes(4).toString('hex')}`;

  const duplicate = memoryDb.devices.find(
    (d) => d.deviceId === hardwareId && d.tenantId === tenant.tenantId
  );
  if (duplicate) {
    return res.status(400).json({ success: false, message: 'This device is already registered to the shop.' });
  }

  const usage = licenceUsage(tenant);
  if (usage.model === 'PER_DEVICE' && usage.available <= 0) {
    return res.status(400).json({
      success: false,
      message: `Licence limit reached — the ${planOf(tenant)?.name || tenant.plan} plan allows ${tenant.maxDevices} device(s). Upgrade the plan or block an existing device.`
    });
  }

  const device = {
    id: `dv_${Date.now()}`,
    tenantId: tenant.tenantId,
    deviceId: hardwareId,
    deviceName,
    model: model || 'Android POS Terminal',
    androidVersion: androidVersion || '—',
    appVersion: appVersion || '—',
    licenseKey: `${tenant.tenantId.slice(0, 4).toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    licenseModel: usage.model,
    status: 'active',
    registeredAt: iso(),
    lastSeenAt: iso()
  };

  memoryDb.devices.push(device);
  addAuditLog('DEVICE_REGISTERED', actorOf(req), `Mapped device "${deviceName}" to shop "${tenant.name}"`);

  res.status(201).json({
    success: true,
    message: `Device "${deviceName}" registered to ${tenant.name}.`,
    data: device
  });
});

router.patch('/devices/:id/status', (req, res) => {
  const device = memoryDb.devices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

  const { status } = req.body;
  if (!['active', 'blocked'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Status must be "active" or "blocked".' });
  }

  if (status === 'active' && device.status === 'blocked') {
    const tenant = memoryDb.tenants.find((t) => t.tenantId === device.tenantId);
    const usage = licenceUsage(tenant);
    if (usage.model === 'PER_DEVICE' && usage.available <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No licence seats free — block another device or upgrade the plan first.'
      });
    }
  }

  device.status = status;
  addAuditLog('DEVICE_STATUS_CHANGE', actorOf(req), `Device "${device.deviceName}" set to ${status.toUpperCase()}`);

  res.json({ success: true, message: `Device ${status === 'active' ? 'activated' : 'blocked'}.`, data: device });
});

router.delete('/devices/:id', (req, res) => {
  const device = memoryDb.devices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

  memoryDb.devices = memoryDb.devices.filter((d) => d.id !== req.params.id);
  addAuditLog('DEVICE_REMOVED', actorOf(req), `Removed device "${device.deviceName}" and released its licence seat`);

  res.json({ success: true, message: 'Device removed and its licence seat released.' });
});

router.post('/devices/validate', (req, res) => {
  const { deviceId, licenseKey } = req.body;
  const device = memoryDb.devices.find((d) => d.deviceId === deviceId || d.licenseKey === licenseKey);

  if (!device) return res.status(404).json({ success: false, message: 'Device is not registered.' });
  if (device.status !== 'active') {
    return res.status(403).json({ success: false, message: 'This device has been blocked by the administrator.' });
  }

  const tenant = memoryDb.tenants.find((t) => t.tenantId === device.tenantId);
  const state = subscriptionState(tenant);

  if (state.status === 'EXPIRED' || state.status === 'SUSPENDED') {
    return res.status(403).json({
      success: false,
      message: state.status === 'EXPIRED' ? 'The shop subscription has expired.' : 'The shop account is suspended.',
      data: { subscription: state }
    });
  }

  device.lastSeenAt = iso();

  res.json({
    success: true,
    message: 'Licence valid.',
    data: {
      device,
      tenant: { tenantId: tenant.tenantId, name: tenant.name, dbName: tenant.dbName, plan: tenant.plan },
      // Resolved so a device sees the same module set the POS routes allow.
      features: resolveTenantFeatures(tenant),
      subscription: state
    }
  });
});

/* ------------------------------------------------------------------ *
 * Plan management
 * ------------------------------------------------------------------ */

// One catalogue for the whole platform — see modules/features.js.
const {
  FEATURE_KEYS,
  FEATURE_CATALOG,
  featuresForPlan,
  resolveTenantFeatures,
  PLAN_DEFAULTS,
  upgradePlanFeatures
} = require('./features');

router.get('/plans/catalog', (req, res) => {
  res.json({
    success: true,
    data: {
      plans: memoryDb.plans.map((plan) => ({
        ...plan,
        subscriberCount: memoryDb.tenants.filter((t) => t.plan === plan.id).length,
        mrr:
          memoryDb.tenants.filter((t) => t.plan === plan.id && t.status === 'active').length *
          (plan.billingCycle === 'Yearly' ? Math.round(plan.price / 12) : plan.price)
      })),
      featureKeys: FEATURE_KEYS,
      featureCatalog: FEATURE_CATALOG
    }
  });
});

router.post('/plans', (req, res) => {
  const { id, name, price, billingCycle, maxDevices, features, licenseModel, trialDays } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Plan name is required.' });

  const planId = (id || name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (memoryDb.plans.some((p) => p.id === planId)) {
    return res.status(400).json({ success: false, message: 'A plan with that identifier already exists.' });
  }

  const plan = {
    id: planId,
    name,
    price: Number(price) || 0,
    billingCycle: billingCycle || 'Monthly',
    maxDevices: Number(maxDevices) || 1,
    features: Array.isArray(features) ? features : [...(PLAN_DEFAULTS[planId] || PLAN_DEFAULTS.starter)],
    licenseModel: licenseModel || 'PER_DEVICE',
    trialDays: Number(trialDays) || 0,
    isActive: true,
    createdAt: iso()
  };

  memoryDb.plans.push(plan);
  addAuditLog('PLAN_CREATED', actorOf(req), `Created subscription tier "${name}" at ₹${plan.price}/${plan.billingCycle}`);

  res.status(201).json({ success: true, message: `Plan "${name}" created.`, data: plan });
});

router.delete('/plans/:id', (req, res) => {
  const plan = memoryDb.plans.find((p) => p.id === req.params.id);
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });

  const subscribers = memoryDb.tenants.filter((t) => t.plan === plan.id);
  if (subscribers.length) {
    return res.status(400).json({
      success: false,
      message: `${subscribers.length} shop(s) are on this plan — move them before deleting it.`
    });
  }

  memoryDb.plans = memoryDb.plans.filter((p) => p.id !== plan.id);
  addAuditLog('PLAN_DELETED', actorOf(req), `Deleted subscription tier "${plan.name}"`);

  res.json({ success: true, message: `Plan "${plan.name}" deleted.` });
});

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

router.get('/subscriptions', (req, res) => {
  const rows = memoryDb.tenants.map((tenant) => {
    const state = subscriptionState(tenant);
    const plan = planOf(tenant);
    const paid = memoryDb.payments
      .filter((p) => p.tenantId === tenant.tenantId && p.status === 'SUCCESS')
      .reduce((s, p) => s + p.amount, 0);

    return {
      tenantId: tenant.tenantId,
      shopName: tenant.name,
      email: tenant.email,
      phone: tenant.phone,
      ...state,
      price: plan?.price || 0,
      billingCycle: plan?.billingCycle || 'Monthly',
      maxDevices: tenant.maxDevices,
      devicesUsed: licenceUsage(tenant).used,
      lifetimeValue: paid
    };
  });

  res.json({
    success: true,
    data: {
      subscriptions: rows,
      summary: {
        active: rows.filter((r) => r.status === 'ACTIVE').length,
        expiringSoon: rows.filter((r) => r.status === 'EXPIRING_SOON').length,
        expired: rows.filter((r) => r.status === 'EXPIRED').length,
        suspended: rows.filter((r) => r.status === 'SUSPENDED').length,
        trials: rows.filter((r) => r.isTrial).length,
        mrr: rows
          .filter((r) => r.status === 'ACTIVE' || r.status === 'EXPIRING_SOON')
          .reduce((s, r) => s + (r.billingCycle === 'Yearly' ? Math.round(r.price / 12) : r.price), 0)
      },
      history: memoryDb.subscriptions.slice(0, 100)
    }
  });
});

const CYCLE_DAYS = { Monthly: 30, Quarterly: 90, Yearly: 365 };

router.post('/subscriptions/:tenantId/renew', (req, res) => {
  const tenant = findTenant(req.params.tenantId);
  if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

  const { planId, cycle, months, paymentId, notes } = req.body;

  if (planId) {
    const plan = memoryDb.plans.find((p) => p.id === planId);
    if (!plan) return res.status(400).json({ success: false, message: 'Unknown plan.' });
    tenant.plan = plan.id;
    tenant.maxDevices = plan.maxDevices;
    tenant.features = featuresForPlan(plan, plan.id);
  }

  const plan = planOf(tenant);
  const days = months ? Number(months) * 30 : CYCLE_DAYS[cycle || plan?.billingCycle || 'Monthly'] || 30;

  const from = daysUntil(tenant.expiryDate) > 0 ? new Date(tenant.expiryDate) : new Date();
  const expiry = new Date(from.getTime() + days * 86400000);

  const previousExpiry = tenant.expiryDate;
  tenant.expiryDate = dayKey(expiry);
  tenant.status = 'active';
  tenant.isTrial = false;

  const record = {
    id: `sub_${Date.now()}`,
    tenantId: tenant.tenantId,
    shopName: tenant.name,
    action: 'RENEWAL',
    plan: tenant.plan,
    planName: plan?.name || tenant.plan,
    amount: plan?.price || 0,
    days,
    previousExpiry,
    newExpiry: tenant.expiryDate,
    paymentId: paymentId || null,
    notes: notes || '',
    performedBy: actorOf(req),
    createdAt: iso()
  };

  memoryDb.subscriptions.unshift(record);
  addAuditLog(
    'SUBSCRIPTION_RENEWED',
    actorOf(req),
    `Renewed "${tenant.name}" on ${plan?.name || tenant.plan} until ${tenant.expiryDate}`
  );

  res.json({
    success: true,
    message: `${tenant.name} renewed until ${tenant.expiryDate}.`,
    data: { tenant, subscription: subscriptionState(tenant), record }
  });
});

router.post('/subscriptions/:tenantId/trial', (req, res) => {
  const tenant = findTenant(req.params.tenantId);
  if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

  const days = Number(req.body.days) || planOf(tenant)?.trialDays || 14;
  const expiry = new Date(Date.now() + days * 86400000);
  const previousExpiry = tenant.expiryDate;

  tenant.expiryDate = dayKey(expiry);
  tenant.status = 'active';
  tenant.isTrial = true;

  memoryDb.subscriptions.unshift({
    id: `sub_${Date.now()}`,
    tenantId: tenant.tenantId,
    shopName: tenant.name,
    action: 'TRIAL',
    plan: tenant.plan,
    planName: planOf(tenant)?.name || tenant.plan,
    amount: 0,
    days,
    previousExpiry,
    newExpiry: tenant.expiryDate,
    notes: `${days}-day trial granted`,
    performedBy: actorOf(req),
    createdAt: iso()
  });

  addAuditLog('TRIAL_GRANTED', actorOf(req), `Granted a ${days}-day trial to "${tenant.name}"`);

  res.json({
    success: true,
    message: `${days}-day trial granted to ${tenant.name}.`,
    data: { tenant, subscription: subscriptionState(tenant) }
  });
});

/* ------------------------------------------------------------------ *
 * Razorpay — SaaS subscription & renewal payments
 * ------------------------------------------------------------------ */

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_selsolve_placeholder';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'selsolve_test_secret';
const isLiveGateway = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

router.get('/payments/config', (req, res) => {
  res.json({
    success: true,
    data: {
      keyId: RAZORPAY_KEY_ID,
      currency: 'INR',
      mode: isLiveGateway ? 'LIVE' : 'SIMULATION',
      companyName: 'Selsolve by Zunasoft'
    }
  });
});

router.get('/payments', (req, res) => {
  const { tenantId, status } = req.query;

  let rows = memoryDb.payments;
  if (tenantId) rows = rows.filter((p) => p.tenantId === tenantId);
  if (status && status !== 'ALL') rows = rows.filter((p) => p.status === status);

  const successful = memoryDb.payments.filter((p) => p.status === 'SUCCESS');

  res.json({
    success: true,
    data: {
      payments: rows,
      summary: {
        collected: successful.reduce((s, p) => s + p.amount, 0),
        count: successful.length,
        failed: memoryDb.payments.filter((p) => p.status === 'FAILED').length,
        pending: memoryDb.payments.filter((p) => p.status === 'CREATED').length,
        thisMonth: successful
          .filter((p) => dayKey(p.paidAt || p.createdAt).slice(0, 7) === dayKey(new Date()).slice(0, 7))
          .reduce((s, p) => s + p.amount, 0)
      }
    }
  });
});

router.post('/payments/order', (req, res) => {
  const { tenantId, planId, purpose, amount: overrideAmount } = req.body;

  const tenant = findTenant(tenantId);
  if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

  const plan = memoryDb.plans.find((p) => p.id === (planId || tenant.plan));
  if (!plan) return res.status(400).json({ success: false, message: 'Unknown plan.' });

  const amount = Number(overrideAmount) || plan.price;
  if (amount <= 0) return res.status(400).json({ success: false, message: 'Payment amount must be positive.' });

  const receipt = `SEL-${tenant.tenantId.slice(0, 6)}-${Date.now().toString().slice(-8)}`;

  const payment = {
    id: `pay_${Date.now()}`,
    orderId: `order_${crypto.randomBytes(8).toString('hex')}`,
    tenantId: tenant.tenantId,
    shopName: tenant.name,
    planId: plan.id,
    planName: plan.name,
    purpose: purpose || 'RENEWAL',
    amount,
    amountInPaise: Math.round(amount * 100),
    currency: 'INR',
    receipt,
    status: 'CREATED',
    gateway: isLiveGateway ? 'RAZORPAY' : 'RAZORPAY_SIMULATION',
    razorpayPaymentId: null,
    failureReason: null,
    createdAt: iso(),
    paidAt: null
  };

  memoryDb.payments.unshift(payment);
  addAuditLog('PAYMENT_ORDER_CREATED', actorOf(req), `Created ₹${amount} ${payment.purpose} order for "${tenant.name}"`);

  res.status(201).json({
    success: true,
    message: `Payment order created for ₹${amount}.`,
    data: {
      ...payment,
      checkout: {
        key: RAZORPAY_KEY_ID,
        order_id: payment.orderId,
        amount: payment.amountInPaise,
        currency: 'INR',
        name: 'Selsolve by Zunasoft',
        description: `${plan.name} — ${payment.purpose.toLowerCase()}`,
        prefill: { email: tenant.email, contact: tenant.phone },
        notes: { tenantId: tenant.tenantId, planId: plan.id }
      }
    }
  });
});

const expectedSignature = (orderId, paymentId) =>
  crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

function capturePayment(payment, { paymentId, signature, actor }) {
  payment.status = 'SUCCESS';
  payment.razorpayPaymentId = paymentId || `sim_${crypto.randomBytes(6).toString('hex')}`;
  payment.signature = signature || null;
  payment.paidAt = iso();

  const tenant = memoryDb.tenants.find((t) => t.tenantId === payment.tenantId);
  const plan = memoryDb.plans.find((p) => p.id === payment.planId);

  if (tenant && plan) {
    const days = CYCLE_DAYS[plan.billingCycle] || 30;
    const from = daysUntil(tenant.expiryDate) > 0 ? new Date(tenant.expiryDate) : new Date();
    const previousExpiry = tenant.expiryDate;

    tenant.plan = plan.id;
    tenant.maxDevices = plan.maxDevices;
    tenant.features = featuresForPlan(plan, plan.id);
    tenant.expiryDate = dayKey(new Date(from.getTime() + days * 86400000));
    tenant.status = 'active';
    tenant.isTrial = false;

    memoryDb.subscriptions.unshift({
      id: `sub_${Date.now()}`,
      tenantId: tenant.tenantId,
      shopName: tenant.name,
      action: payment.purpose,
      plan: plan.id,
      planName: plan.name,
      amount: payment.amount,
      days,
      previousExpiry,
      newExpiry: tenant.expiryDate,
      paymentId: payment.id,
      notes: `Paid online via ${payment.gateway}`,
      performedBy: 'Razorpay',
      createdAt: iso()
    });
  }

  addAuditLog(
    'PAYMENT_SUCCESS',
    actor,
    `Captured ₹${payment.amount} from "${payment.shopName}" — extended to ${tenant?.expiryDate}`
  );

  return {
    message: `Payment of ₹${payment.amount} captured. ${tenant?.name} is active until ${tenant?.expiryDate}.`,
    data: { payment, tenant, subscription: tenant ? subscriptionState(tenant) : null }
  };
}

function failPayment(payment, { reason, code, actor }) {
  payment.status = 'FAILED';
  payment.failureReason = reason || 'Payment was cancelled or declined';
  payment.failureCode = code || null;
  payment.failedAt = iso();

  addAuditLog(
    'PAYMENT_FAILED',
    actor,
    `Payment of ₹${payment.amount} for "${payment.shopName}" failed — ${payment.failureReason}`,
    'FAILED'
  );

  return { message: 'Payment failure recorded.', data: payment };
}

router.post('/payments/verify', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const payment = memoryDb.payments.find((p) => p.orderId === razorpay_order_id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment order not found.' });
  if (payment.status === 'SUCCESS') {
    return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
  }

  if (isLiveGateway && expectedSignature(razorpay_order_id, razorpay_payment_id) !== razorpay_signature) {
    failPayment(payment, { reason: 'Signature verification failed', code: 'SIGNATURE_MISMATCH', actor: actorOf(req) });
    return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
  }

  const result = capturePayment(payment, {
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
    actor: actorOf(req)
  });

  res.json({ success: true, ...result });
});

router.post('/payments/failure', (req, res) => {
  const payment = memoryDb.payments.find((p) => p.orderId === req.body.razorpay_order_id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment order not found.' });

  const result = failPayment(payment, {
    reason: req.body.reason,
    code: req.body.code,
    actor: actorOf(req)
  });

  res.json({ success: true, ...result });
});

router.post('/payments/:id/simulate', (req, res) => {
  const payment = memoryDb.payments.find((p) => p.id === req.params.id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
  if (isLiveGateway) {
    return res.status(400).json({ success: false, message: 'Simulation is disabled while live keys are configured.' });
  }
  if (payment.status === 'SUCCESS') {
    return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
  }

  const result =
    req.body.outcome === 'FAILED'
      ? failPayment(payment, {
          reason: 'Simulated failure — card declined',
          code: 'BAD_REQUEST_ERROR',
          actor: actorOf(req)
        })
      : capturePayment(payment, {
          paymentId: `pay_sim_${crypto.randomBytes(6).toString('hex')}`,
          signature: null,
          actor: actorOf(req)
        });

  res.json({ success: true, ...result });
});

module.exports = router;
module.exports.subscriptionState = subscriptionState;
module.exports.licenceUsage = licenceUsage;
module.exports.FEATURE_KEYS = FEATURE_KEYS;
