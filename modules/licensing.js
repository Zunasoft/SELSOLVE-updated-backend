
const express = require('express');
const crypto = require('crypto');
const { models, addAuditLog, findTenant } = require('../db');

// One catalogue for the whole platform — see modules/features.js.
const {
  FEATURE_KEYS,
  FEATURE_CATALOG,
  featuresForPlan,
  resolveTenantFeatures,
  PLAN_DEFAULTS,
  upgradePlanFeatures
} = require('./features');

const router = express.Router();

const actorOf = (req) => req.admin?.email || 'SuperAdmin';
const iso = () => new Date().toISOString();
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const daysUntil = (date) => Math.ceil((new Date(date) - new Date()) / 86400000);

/** Wrap an async handler so a rejected promise reaches the error middleware. */
const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

/**
 * Fill in the licensing fields a plan written before this module existed does
 * not carry, and widen any pre-catalogue feature list. Applied on read, so an
 * old plan document never reads as "no trial, no licence model".
 */
function withPlanDefaults(plan) {
  if (!plan) return null;
  const filled = upgradePlanFeatures({ ...plan });
  if (!filled.licenseModel) filled.licenseModel = filled.id === 'enterprise' ? 'PER_ORGANISATION' : 'PER_DEVICE';
  if (!filled.billingCycle) filled.billingCycle = 'Monthly';
  if (filled.trialDays === undefined) filled.trialDays = filled.id === 'starter' ? 14 : 0;
  if (filled.isActive === undefined) filled.isActive = true;
  return filled;
}

const allPlans = async () => (await models.Plan.find().sort({ price: 1 }).lean()).map(withPlanDefaults);

const planById = async (planId) =>
  planId ? withPlanDefaults(await models.Plan.findOne({ id: planId }).lean()) : null;

const planOf = (tenant, plans) => plans.find((p) => p.id === tenant.plan) || null;

/* ------------------------------------------------------------------ *
 * Licence & subscription state
 * ------------------------------------------------------------------ */

function licenceUsage(tenant, plan, devices = []) {
  const active = devices.filter((d) => d.status === 'active');
  const model = plan?.licenseModel || 'PER_DEVICE';

  return {
    model,
    seats: model === 'PER_ORGANISATION' ? null : tenant.maxDevices,
    used: active.length,
    available: model === 'PER_ORGANISATION' ? null : Math.max(0, (tenant.maxDevices || 0) - active.length),
    registered: devices.length,
    blocked: devices.filter((d) => d.status === 'blocked').length
  };
}

async function licenceUsageFor(tenant) {
  const [plan, devices] = await Promise.all([
    planById(tenant.plan),
    models.Device.find({ tenantId: tenant.tenantId }).lean()
  ]);
  return licenceUsage(tenant, plan, devices);
}

function subscriptionState(tenant, plan) {
  const remaining = daysUntil(tenant.expiryDate);
  return {
    plan: tenant.plan,
    planName: plan?.name || tenant.plan,
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

const subscriptionStateFor = async (tenant) => subscriptionState(tenant, await planById(tenant.plan));

/* ------------------------------------------------------------------ *
 * Device management
 * ------------------------------------------------------------------ */

router.get(
  '/devices',
  handler(async (req, res) => {
    const { tenantId, status } = req.query;

    const [allDevices, tenants, plans] = await Promise.all([
      models.Device.find().sort({ registeredAt: -1 }).lean(),
      models.Tenant.find().lean(),
      allPlans()
    ]);

    let rows = allDevices;
    if (tenantId) rows = rows.filter((d) => d.tenantId === tenantId);
    if (status && status !== 'ALL') rows = rows.filter((d) => d.status === status);

    const byTenant = new Map();
    for (const device of allDevices) {
      if (!byTenant.has(device.tenantId)) byTenant.set(device.tenantId, []);
      byTenant.get(device.tenantId).push(device);
    }

    res.json({
      success: true,
      data: {
        devices: rows.map((d) => ({
          ...d,
          shopName: tenants.find((t) => t.tenantId === d.tenantId)?.name || '—'
        })),
        summary: {
          total: allDevices.length,
          active: allDevices.filter((d) => d.status === 'active').length,
          blocked: allDevices.filter((d) => d.status === 'blocked').length,
          online: allDevices.filter((d) => d.lastSeenAt && daysUntil(d.lastSeenAt) > -1).length
        },
        licences: tenants.map((t) => ({
          tenantId: t.tenantId,
          shopName: t.name,
          plan: t.plan,
          ...licenceUsage(t, planOf(t, plans), byTenant.get(t.tenantId) || [])
        }))
      }
    });
  })
);

router.post(
  '/devices',
  handler(async (req, res) => {
    const { tenantId, deviceName, deviceId, model, androidVersion, appVersion } = req.body;

    const tenant = await findTenant({ id: tenantId });
    if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });
    if (!deviceName) return res.status(400).json({ success: false, message: 'Device name is required.' });

    const hardwareId = deviceId || `dev-${crypto.randomBytes(4).toString('hex')}`;

    const duplicate = await models.Device.findOne({ tenantId: tenant.tenantId, deviceId: hardwareId }).lean();
    if (duplicate) {
      return res.status(400).json({ success: false, message: 'This device is already registered to the shop.' });
    }

    const plan = await planById(tenant.plan);
    const devices = await models.Device.find({ tenantId: tenant.tenantId }).lean();
    const usage = licenceUsage(tenant, plan, devices);

    if (usage.model === 'PER_DEVICE' && usage.available <= 0) {
      return res.status(400).json({
        success: false,
        message: `Licence limit reached — the ${plan?.name || tenant.plan} plan allows ${tenant.maxDevices} device(s). Upgrade the plan or block an existing device.`
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

    await models.Device.create(device);
    await addAuditLog('DEVICE_REGISTERED', actorOf(req), `Mapped device "${deviceName}" to shop "${tenant.name}"`);

    res.status(201).json({
      success: true,
      message: `Device "${deviceName}" registered to ${tenant.name}.`,
      data: device
    });
  })
);

router.patch(
  '/devices/:id/status',
  handler(async (req, res) => {
    const device = await models.Device.findOne({ id: req.params.id }).lean();
    if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

    const { status } = req.body;
    if (!['active', 'blocked'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be "active" or "blocked".' });
    }

    if (status === 'active' && device.status === 'blocked') {
      const tenant = await models.Tenant.findOne({ tenantId: device.tenantId }).lean();
      if (tenant) {
        const usage = await licenceUsageFor(tenant);
        if (usage.model === 'PER_DEVICE' && usage.available <= 0) {
          return res.status(400).json({
            success: false,
            message: 'No licence seats free — block another device or upgrade the plan first.'
          });
        }
      }
    }

    const updated = await models.Device.findOneAndUpdate(
      { id: device.id },
      { $set: { status } },
      { new: true, lean: true }
    );

    await addAuditLog(
      'DEVICE_STATUS_CHANGE',
      actorOf(req),
      `Device "${device.deviceName}" set to ${status.toUpperCase()}`
    );

    res.json({ success: true, message: `Device ${status === 'active' ? 'activated' : 'blocked'}.`, data: updated });
  })
);

router.delete(
  '/devices/:id',
  handler(async (req, res) => {
    const device = await models.Device.findOneAndDelete({ id: req.params.id }).lean();
    if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

    await addAuditLog(
      'DEVICE_REMOVED',
      actorOf(req),
      `Removed device "${device.deviceName}" and released its licence seat`
    );

    res.json({ success: true, message: 'Device removed and its licence seat released.' });
  })
);

router.post(
  '/devices/validate',
  handler(async (req, res) => {
    const { deviceId, licenseKey } = req.body;

    const device = await models.Device.findOne({
      $or: [{ deviceId: deviceId || '__none__' }, { licenseKey: licenseKey || '__none__' }]
    }).lean();

    if (!device) return res.status(404).json({ success: false, message: 'Device is not registered.' });
    if (device.status !== 'active') {
      return res.status(403).json({ success: false, message: 'This device has been blocked by the administrator.' });
    }

    const tenant = await models.Tenant.findOne({ tenantId: device.tenantId }).lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'The shop for this device no longer exists.' });

    const plan = await planById(tenant.plan);
    const state = subscriptionState(tenant, plan);

    if (state.status === 'EXPIRED' || state.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        message: state.status === 'EXPIRED' ? 'The shop subscription has expired.' : 'The shop account is suspended.',
        data: { subscription: state }
      });
    }

    const lastSeenAt = iso();
    await models.Device.updateOne({ id: device.id }, { $set: { lastSeenAt } });

    res.json({
      success: true,
      message: 'Licence valid.',
      data: {
        device: { ...device, lastSeenAt },
        tenant: { tenantId: tenant.tenantId, name: tenant.name, dbName: tenant.dbName, plan: tenant.plan },
        // Resolved so a device sees the same module set the POS routes allow.
        features: resolveTenantFeatures(tenant),
        subscription: state
      }
    });
  })
);

/* ------------------------------------------------------------------ *
 * Plan management
 * ------------------------------------------------------------------ */

router.get(
  '/plans/catalog',
  handler(async (req, res) => {
    const [plans, tenants] = await Promise.all([allPlans(), models.Tenant.find({}, { plan: 1, status: 1 }).lean()]);

    res.json({
      success: true,
      data: {
        plans: plans.map((plan) => ({
          ...plan,
          subscriberCount: tenants.filter((t) => t.plan === plan.id).length,
          mrr:
            tenants.filter((t) => t.plan === plan.id && t.status === 'active').length *
            (plan.billingCycle === 'Yearly' ? Math.round(plan.price / 12) : plan.price)
        })),
        featureKeys: FEATURE_KEYS,
        featureCatalog: FEATURE_CATALOG
      }
    });
  })
);

router.post(
  '/plans',
  handler(async (req, res) => {
    const { id, name, price, billingCycle, maxDevices, features, licenseModel, trialDays } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Plan name is required.' });

    const planId = (id || name).toLowerCase().replace(/[^a-z0-9]/g, '');
    const clash = await models.Plan.findOne({ id: planId }).lean();
    if (clash) {
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
      featureSchema: 2,
      createdAt: iso()
    };

    await models.Plan.create(plan);
    await addAuditLog(
      'PLAN_CREATED',
      actorOf(req),
      `Created subscription tier "${name}" at ₹${plan.price}/${plan.billingCycle}`
    );

    res.status(201).json({ success: true, message: `Plan "${name}" created.`, data: plan });
  })
);

router.delete(
  '/plans/:id',
  handler(async (req, res) => {
    const plan = await models.Plan.findOne({ id: req.params.id }).lean();
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });

    const subscribers = await models.Tenant.countDocuments({ plan: plan.id });
    if (subscribers) {
      return res.status(400).json({
        success: false,
        message: `${subscribers} shop(s) are on this plan — move them before deleting it.`
      });
    }

    await models.Plan.deleteOne({ id: plan.id });
    await addAuditLog('PLAN_DELETED', actorOf(req), `Deleted subscription tier "${plan.name}"`);

    res.json({ success: true, message: `Plan "${plan.name}" deleted.` });
  })
);

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

router.get(
  '/subscriptions',
  handler(async (req, res) => {
    const [tenants, plans, devices, payments, history] = await Promise.all([
      models.Tenant.find().lean(),
      allPlans(),
      models.Device.find({}, { tenantId: 1, status: 1 }).lean(),
      models.Payment.find({ status: 'SUCCESS' }, { tenantId: 1, amount: 1 }).lean(),
      models.Subscription.find().sort({ createdAt: -1 }).limit(100).lean()
    ]);

    const rows = tenants.map((tenant) => {
      const plan = planOf(tenant, plans);
      const state = subscriptionState(tenant, plan);
      const shopDevices = devices.filter((d) => d.tenantId === tenant.tenantId);
      const paid = payments
        .filter((p) => p.tenantId === tenant.tenantId)
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);

      return {
        tenantId: tenant.tenantId,
        shopName: tenant.name,
        email: tenant.email,
        phone: tenant.phone,
        ...state,
        price: plan?.price || 0,
        billingCycle: plan?.billingCycle || 'Monthly',
        maxDevices: tenant.maxDevices,
        devicesUsed: licenceUsage(tenant, plan, shopDevices).used,
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
        history
      }
    });
  })
);

const CYCLE_DAYS = { Monthly: 30, Quarterly: 90, Yearly: 365 };

router.post(
  '/subscriptions/:tenantId/renew',
  handler(async (req, res) => {
    const tenant = await findTenant({ id: req.params.tenantId });
    if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

    const { planId, cycle, months, paymentId, notes } = req.body;

    const update = {};
    let plan = await planById(tenant.plan);

    if (planId && planId !== tenant.plan) {
      const nextPlan = await planById(planId);
      if (!nextPlan) return res.status(400).json({ success: false, message: 'Unknown plan.' });
      plan = nextPlan;
      update.plan = nextPlan.id;
      update.maxDevices = nextPlan.maxDevices;
      update.features = featuresForPlan(nextPlan, nextPlan.id);
    }

    const days = months ? Number(months) * 30 : CYCLE_DAYS[cycle || plan?.billingCycle || 'Monthly'] || 30;
    const from = daysUntil(tenant.expiryDate) > 0 ? new Date(tenant.expiryDate) : new Date();
    const previousExpiry = tenant.expiryDate;

    update.expiryDate = dayKey(new Date(from.getTime() + days * 86400000));
    update.status = 'active';
    update.isTrial = false;

    const updated = await models.Tenant.findOneAndUpdate({ id: tenant.id }, { $set: update }, { new: true, lean: true });

    const record = {
      id: `sub_${Date.now()}`,
      tenantId: updated.tenantId,
      shopName: updated.name,
      action: 'RENEWAL',
      plan: updated.plan,
      planName: plan?.name || updated.plan,
      amount: plan?.price || 0,
      days,
      previousExpiry,
      newExpiry: updated.expiryDate,
      paymentId: paymentId || null,
      notes: notes || '',
      performedBy: actorOf(req),
      createdAt: iso()
    };

    await models.Subscription.create(record);
    await addAuditLog(
      'SUBSCRIPTION_RENEWED',
      actorOf(req),
      `Renewed "${updated.name}" on ${plan?.name || updated.plan} until ${updated.expiryDate}`
    );

    res.json({
      success: true,
      message: `${updated.name} renewed until ${updated.expiryDate}.`,
      data: { tenant: updated, subscription: subscriptionState(updated, plan), record }
    });
  })
);

router.post(
  '/subscriptions/:tenantId/trial',
  handler(async (req, res) => {
    const tenant = await findTenant({ id: req.params.tenantId });
    if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

    const plan = await planById(tenant.plan);
    const days = Number(req.body.days) || plan?.trialDays || 14;
    const previousExpiry = tenant.expiryDate;
    const expiryDate = dayKey(new Date(Date.now() + days * 86400000));

    const updated = await models.Tenant.findOneAndUpdate(
      { id: tenant.id },
      { $set: { expiryDate, status: 'active', isTrial: true } },
      { new: true, lean: true }
    );

    await models.Subscription.create({
      id: `sub_${Date.now()}`,
      tenantId: updated.tenantId,
      shopName: updated.name,
      action: 'TRIAL',
      plan: updated.plan,
      planName: plan?.name || updated.plan,
      amount: 0,
      days,
      previousExpiry,
      newExpiry: updated.expiryDate,
      notes: `${days}-day trial granted`,
      performedBy: actorOf(req),
      createdAt: iso()
    });

    await addAuditLog('TRIAL_GRANTED', actorOf(req), `Granted a ${days}-day trial to "${updated.name}"`);

    res.json({
      success: true,
      message: `${days}-day trial granted to ${updated.name}.`,
      data: { tenant: updated, subscription: subscriptionState(updated, plan) }
    });
  })
);

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

router.get(
  '/payments',
  handler(async (req, res) => {
    const { tenantId, status } = req.query;

    const all = await models.Payment.find().sort({ createdAt: -1 }).limit(500).lean();

    let rows = all;
    if (tenantId) rows = rows.filter((p) => p.tenantId === tenantId);
    if (status && status !== 'ALL') rows = rows.filter((p) => p.status === status);

    const successful = all.filter((p) => p.status === 'SUCCESS');
    const thisMonth = dayKey(new Date()).slice(0, 7);

    res.json({
      success: true,
      data: {
        payments: rows,
        summary: {
          collected: successful.reduce((s, p) => s + Number(p.amount || 0), 0),
          count: successful.length,
          failed: all.filter((p) => p.status === 'FAILED').length,
          pending: all.filter((p) => p.status === 'CREATED').length,
          thisMonth: successful
            .filter((p) => dayKey(p.paidAt || p.createdAt).slice(0, 7) === thisMonth)
            .reduce((s, p) => s + Number(p.amount || 0), 0)
        }
      }
    });
  })
);

router.post(
  '/payments/order',
  handler(async (req, res) => {
    const { tenantId, planId, purpose, amount: overrideAmount } = req.body;

    const tenant = await findTenant({ id: tenantId });
    if (!tenant) return res.status(404).json({ success: false, message: 'Shop not found.' });

    const plan = await planById(planId || tenant.plan);
    if (!plan) return res.status(400).json({ success: false, message: 'Unknown plan.' });

    const amount = Number(overrideAmount) || plan.price;
    if (amount <= 0) return res.status(400).json({ success: false, message: 'Payment amount must be positive.' });

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
      receipt: `SEL-${tenant.tenantId.slice(0, 6)}-${Date.now().toString().slice(-8)}`,
      status: 'CREATED',
      gateway: isLiveGateway ? 'RAZORPAY' : 'RAZORPAY_SIMULATION',
      razorpayPaymentId: null,
      failureReason: null,
      createdAt: iso(),
      paidAt: null
    };

    await models.Payment.create(payment);
    await addAuditLog(
      'PAYMENT_ORDER_CREATED',
      actorOf(req),
      `Created ₹${amount} ${payment.purpose} order for "${tenant.name}"`
    );

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
  })
);

const expectedSignature = (orderId, paymentId) =>
  crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

/**
 * Mark a payment captured and extend the shop's subscription.
 *
 * The payment row is only flipped to SUCCESS if it is still CREATED, so two
 * verify callbacks for the same order cannot extend the subscription twice.
 */
async function capturePayment(payment, { paymentId, signature, actor }) {
  const paidAt = iso();
  const claimed = await models.Payment.findOneAndUpdate(
    { id: payment.id, status: 'CREATED' },
    {
      $set: {
        status: 'SUCCESS',
        razorpayPaymentId: paymentId || `sim_${crypto.randomBytes(6).toString('hex')}`,
        signature: signature || null,
        paidAt
      }
    },
    { new: true, lean: true }
  );

  if (!claimed) return null;

  const [tenant, plan] = await Promise.all([
    models.Tenant.findOne({ tenantId: claimed.tenantId }).lean(),
    planById(claimed.planId)
  ]);

  let updatedTenant = tenant;

  if (tenant && plan) {
    const days = CYCLE_DAYS[plan.billingCycle] || 30;
    const from = daysUntil(tenant.expiryDate) > 0 ? new Date(tenant.expiryDate) : new Date();
    const previousExpiry = tenant.expiryDate;
    const expiryDate = dayKey(new Date(from.getTime() + days * 86400000));

    updatedTenant = await models.Tenant.findOneAndUpdate(
      { id: tenant.id },
      {
        $set: {
          plan: plan.id,
          maxDevices: plan.maxDevices,
          features: featuresForPlan(plan, plan.id),
          expiryDate,
          status: 'active',
          isTrial: false
        }
      },
      { new: true, lean: true }
    );

    await models.Subscription.create({
      id: `sub_${Date.now()}`,
      tenantId: tenant.tenantId,
      shopName: tenant.name,
      action: claimed.purpose,
      plan: plan.id,
      planName: plan.name,
      amount: claimed.amount,
      days,
      previousExpiry,
      newExpiry: expiryDate,
      paymentId: claimed.id,
      notes: `Paid online via ${claimed.gateway}`,
      performedBy: 'Razorpay',
      createdAt: iso()
    });
  }

  await addAuditLog(
    'PAYMENT_SUCCESS',
    actor,
    `Captured ₹${claimed.amount} from "${claimed.shopName}" — extended to ${updatedTenant?.expiryDate}`
  );

  return {
    message: `Payment of ₹${claimed.amount} captured. ${updatedTenant?.name} is active until ${updatedTenant?.expiryDate}.`,
    data: {
      payment: claimed,
      tenant: updatedTenant,
      subscription: updatedTenant ? subscriptionState(updatedTenant, plan) : null
    }
  };
}

async function failPayment(payment, { reason, code, actor }) {
  const updated = await models.Payment.findOneAndUpdate(
    { id: payment.id },
    {
      $set: {
        status: 'FAILED',
        failureReason: reason || 'Payment was cancelled or declined',
        failureCode: code || null,
        failedAt: iso()
      }
    },
    { new: true, lean: true }
  );

  await addAuditLog(
    'PAYMENT_FAILED',
    actor,
    `Payment of ₹${updated.amount} for "${updated.shopName}" failed — ${updated.failureReason}`,
    'FAILED'
  );

  return { message: 'Payment failure recorded.', data: updated };
}

router.post(
  '/payments/verify',
  handler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const payment = await models.Payment.findOne({ orderId: razorpay_order_id }).lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Payment order not found.' });
    if (payment.status === 'SUCCESS') {
      return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
    }

    if (isLiveGateway && expectedSignature(razorpay_order_id, razorpay_payment_id) !== razorpay_signature) {
      await failPayment(payment, {
        reason: 'Signature verification failed',
        code: 'SIGNATURE_MISMATCH',
        actor: actorOf(req)
      });
      return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
    }

    const result = await capturePayment(payment, {
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      actor: actorOf(req)
    });

    if (!result) {
      return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
    }

    res.json({ success: true, ...result });
  })
);

router.post(
  '/payments/failure',
  handler(async (req, res) => {
    const payment = await models.Payment.findOne({ orderId: req.body.razorpay_order_id }).lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Payment order not found.' });

    const result = await failPayment(payment, {
      reason: req.body.reason,
      code: req.body.code,
      actor: actorOf(req)
    });

    res.json({ success: true, ...result });
  })
);

router.post(
  '/payments/:id/simulate',
  handler(async (req, res) => {
    const payment = await models.Payment.findOne({ id: req.params.id }).lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (isLiveGateway) {
      return res.status(400).json({ success: false, message: 'Simulation is disabled while live keys are configured.' });
    }
    if (payment.status === 'SUCCESS') {
      return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
    }

    const result =
      req.body.outcome === 'FAILED'
        ? await failPayment(payment, {
            reason: 'Simulated failure — card declined',
            code: 'BAD_REQUEST_ERROR',
            actor: actorOf(req)
          })
        : await capturePayment(payment, {
            paymentId: `pay_sim_${crypto.randomBytes(6).toString('hex')}`,
            signature: null,
            actor: actorOf(req)
          });

    if (!result) {
      return res.status(400).json({ success: false, message: 'This payment has already been captured.' });
    }

    res.json({ success: true, ...result });
  })
);

module.exports = router;
module.exports.subscriptionState = subscriptionState;
module.exports.subscriptionStateFor = subscriptionStateFor;
module.exports.licenceUsage = licenceUsage;
module.exports.licenceUsageFor = licenceUsageFor;
module.exports.FEATURE_KEYS = FEATURE_KEYS;
