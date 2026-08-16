/**
 * Selsolve — Smart Retail POS & Super Admin Unified Master Backend Server.
 *
 * Data architecture: one master database (`selsolve`) holding tenants, plans,
 * super admins, devices, subscriptions, payments, settings, login codes and the
 * audit trail — plus one isolated `tenant_db_<slug>` database per shop holding
 * that shop's operational data.
 *
 * Every request reads and writes those databases directly. Nothing is served
 * from process memory, because on a serverless host consecutive requests are
 * handled by different instances that share no memory at all.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const config = require('./config/config');
const {
  models,
  connectMasterDB,
  ensureMasterDB,
  requireMasterDB,
  addAuditLog,
  getSettings,
  getOtpExpiryMinutes,
  getPlan,
  findTenant,
  SEED_SUPER_ADMIN_EMAIL,
  getIsMongoConnected,
  getMongoDiagnostics
} = require('./db');
const { authRouter, requireSuperAdmin, findSuperAdmin } = require('./auth');
const { sendOtpEmail, verifyMailer, isSmtpConfigured } = require('./mailer');
const licensingModule = require('./modules/licensing');
const { usersRouter, enforceReadOnly } = require('./modules/users');
const {
  featuresForPlan,
  enforcePlanFeatures,
  FEATURE_CATALOG,
  normaliseFeatures,
  resolveTenantFeatures
} = require('./modules/features');
const { resolveTenantDb } = require('./middlewares/tenant.middleware');
const { notFoundHandler, errorHandler } = require('./middlewares/error.middleware');
const apiRoutes = require('./routes');

const app = express();
const PORT = process.env.PORT || config.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_zunasoft_2026';

// Warm the master connection at boot. Requests do not depend on this having
// finished — each one calls ensureMasterDB() itself — but a warm instance
// answers its first request without paying for the handshake.
connectMasterDB().catch(() => {});
verifyMailer();

// CORS setup
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const cleanOrigin = origin.replace(/\/$/, '');
    if (
      config.ALLOWED_ORIGINS.includes(cleanOrigin) ||
      config.ALLOWED_ORIGINS.includes('*') ||
      /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(cleanOrigin) ||
      cleanOrigin.endsWith('.vercel.app')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-db', 'x-user-name', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

/**
 * Product images, served from the shop's own database.
 *
 * Reached from a plain `<img src>`, which cannot send an Authorization header,
 * so the route is public and the unguessable filename is what protects it —
 * the same posture as the static directory this replaced. The shop is named in
 * the path because that is what says which database to read.
 */
app.get('/uploads/products/:slug/:filename', async (req, res) => {
  if (!(await ensureMasterDB())) {
    return res.status(503).json({ success: false, message: 'Image store is unavailable.' });
  }

  const tenant = await models.Tenant.findOne({ slug: req.params.slug }, { dbName: 1 }).lean();
  if (!tenant) return res.status(404).json({ success: false, message: 'Image not found.' });

  const { getTenantDb } = require('./tenantDb');
  const db = getTenantDb(tenant.dbName);
  if (!db) return res.status(503).json({ success: false, message: 'Image store is unavailable.' });

  const image = await db.collection('productimages').findOne({ filename: path.basename(req.params.filename) });
  if (!image) return res.status(404).json({ success: false, message: 'Image not found.' });

  // The filename embeds a timestamp and random suffix, so the bytes behind a
  // given URL never change and the browser may keep it indefinitely.
  res.set('Content-Type', image.contentType || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(image.data.buffer ? Buffer.from(image.data.buffer) : image.data);
});

// Images uploaded to disk by earlier builds stay reachable at their old URLs.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/**
 * Every API call needs the master database. Refusing here — rather than
 * answering from whatever this instance happens to hold in memory — is what
 * keeps a registered shop from reading as unregistered on a cold instance.
 *
 * `/api/health` is exempt: its job is to report the outage, not to fail with it.
 */
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return requireMasterDB(req, res, next);
});

// --- SUPER ADMIN AUTHENTICATION (public: email + OTP) ---
app.use('/api/admin/auth', authRouter);

// Everything else under /api/admin requires a valid console session token.
app.use('/api/admin', requireSuperAdmin);

// A read-only role may call GET and nothing else. Applied across the whole
// admin API rather than route by route, so a screen added later is covered
// without anyone having to remember to guard it.
app.use('/api/admin', enforceReadOnly);

// Console user management — who may sign in, and what they may do.
app.use('/api/admin', usersRouter);

// Device management, subscriptions, plan catalogue and Razorpay payments
app.use('/api/admin', licensingModule);

// --- SUPER ADMIN TENANT MANAGEMENT ENDPOINTS (protected) ---
const actorOf = (req) => req.admin?.email || 'SuperAdmin';

/** Wrap an async handler so a rejected promise reaches the error middleware. */
const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Get Overview Stats
app.get(
  '/api/admin/stats',
  handler(async (req, res) => {
    const [tenants, plans] = await Promise.all([
      models.Tenant.find({}, { plan: 1, status: 1 }).lean(),
      models.Plan.find().lean()
    ]);

    const priceOf = (planId) => plans.find((p) => p.id === planId)?.price || 0;

    res.json({
      success: true,
      data: {
        totalShops: tenants.length,
        activeShops: tenants.filter((t) => t.status === 'active').length,
        inactiveShops: tenants.filter((t) => t.status !== 'active').length,
        mrr: tenants.reduce((acc, t) => acc + priceOf(t.plan), 0),
        databaseStatus: 'Healthy (Multi-Tenant Isolated DB Pool)'
      }
    });
  })
);

// Get Tenants List
app.get(
  '/api/admin/tenants',
  handler(async (req, res) => {
    const tenants = await models.Tenant.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: tenants });
  })
);

/**
 * Derive a database name that no existing shop is already using.
 * Two shops with similar names ("SB Enterprises" / "S.B. Enterprises") would
 * otherwise slug to the same value and end up sharing one database.
 */
const uniqueSlugFor = async (name) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'shop';

  const rows = await models.Tenant.find(
    { $or: [{ slug: new RegExp(`^${escapeRegex(base)}\\d*$`) }, { tenantId: new RegExp(`^${escapeRegex(base)}\\d*$`) }] },
    { slug: 1, tenantId: 1 }
  ).lean();

  const taken = new Set(rows.flatMap((t) => [t.slug, t.tenantId].filter(Boolean)));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
};

// Create New Tenant Shop (Provisions unique DB)
app.post(
  '/api/admin/tenants',
  handler(async (req, res) => {
    const { name, email, phone, plan, maxDevices } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Shop name and email are required' });
    }

    const address = String(email).trim().toLowerCase();
    const existing = await models.Tenant.findOne({ email: address }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: 'A shop with this email already exists.' });
    }

    const slug = await uniqueSlugFor(name);
    const planId = plan || 'starter';
    const planDoc = await getPlan(planId);
    const dbName = `tenant_db_${slug}`;

    const newTenant = {
      id: `t_${Date.now()}`,
      tenantId: slug,
      name,
      slug,
      email: address,
      phone: phone || '+91 9000000000',
      dbName,
      status: 'active',
      plan: planId,
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      maxDevices: Number(maxDevices) || planDoc?.maxDevices || 2,
      // The tier the shop was sold decides which modules it can open. Stamped at
      // provisioning time so a later edit to the plan never silently revokes a
      // capability the shop is already using — that takes an explicit plan change.
      features: featuresForPlan(planDoc, planId),
      createdAt: new Date().toISOString()
    };

    // Master DB records who the tenant is...
    await models.Tenant.create(newTenant);

    // ...and the tenant's own database is created and seeded here. A shop whose
    // database could not be built is removed again rather than left as a record
    // pointing at nothing.
    try {
      const { provisionTenantDB } = require('./tenantProvisioner');
      await provisionTenantDB(dbName, newTenant);
    } catch (dbErr) {
      console.error('[Tenant provisioning error]:', dbErr.message);
      await models.Tenant.deleteOne({ id: newTenant.id });
      await addAuditLog('TENANT_PROVISION_FAILED', actorOf(req), `Failed to provision "${name}": ${dbErr.message}`, 'FAILED');
      return res.status(500).json({
        success: false,
        message: `Could not provision the isolated database for "${name}". ${dbErr.message}`
      });
    }

    console.log(`[Super Admin] Provisioned new tenant DB: ${dbName} for shop "${name}"`);
    await addAuditLog('TENANT_PROVISIONED', actorOf(req), `Provisioned new isolated DB ${dbName} for "${name}"`);

    res.status(201).json({
      success: true,
      message: `Shop created and isolated database (${dbName}) provisioned successfully.`,
      data: newTenant
    });
  })
);

// Toggle Tenant Status (Activate / Deactivate)
app.patch(
  '/api/admin/tenants/:id/status',
  handler(async (req, res) => {
    const { status } = req.body;

    const tenant = await models.Tenant.findOneAndUpdate(
      { $or: [{ id: req.params.id }, { tenantId: req.params.id }] },
      { $set: { status } },
      { new: true, lean: true }
    );

    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    await addAuditLog(
      'TENANT_STATUS_CHANGE',
      actorOf(req),
      `Changed status of "${tenant.name}" to ${String(status).toUpperCase()}`
    );

    res.json({
      success: true,
      message: `Tenant "${tenant.name}" status updated to ${status}`,
      data: tenant
    });
  })
);

// Update Tenant Profile Details
app.put(
  '/api/admin/tenants/:id',
  handler(async (req, res) => {
    const { name, phone, email, plan, maxDevices, expiryDate, features } = req.body;

    const tenant = await findTenant({ id: req.params.id });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const update = {};
    if (name) update.name = name;
    if (phone) update.phone = phone;
    if (email) update.email = String(email).trim().toLowerCase();

    // Moving to a different tier re-derives the feature set from that tier.
    let planId = tenant.plan;
    if (plan && plan !== tenant.plan) {
      planId = plan;
      update.plan = plan;
      update.features = featuresForPlan(await getPlan(plan), plan);
    }

    // A per-shop override always wins over the tier default — this is how a
    // Super Admin grants one shop a capability its plan does not normally carry.
    if (features) update.features = normaliseFeatures(features, planId);

    if (maxDevices) update.maxDevices = parseInt(maxDevices, 10) || tenant.maxDevices;
    if (expiryDate) update.expiryDate = expiryDate;

    if (update.email && update.email !== tenant.email) {
      const clash = await models.Tenant.findOne({ email: update.email, id: { $ne: tenant.id } }).lean();
      if (clash) {
        return res.status(400).json({ success: false, message: 'Another shop is already registered with this email.' });
      }
    }

    const updated = await models.Tenant.findOneAndUpdate({ id: tenant.id }, { $set: update }, { new: true, lean: true });

    await addAuditLog(
      'TENANT_EDIT',
      actorOf(req),
      `Updated shop settings & plan for "${updated.name}" (${String(updated.plan).toUpperCase()})`
    );

    res.json({
      success: true,
      message: `Updated tenant profile for ${updated.name}`,
      data: updated
    });
  })
);

/**
 * View Shop Details — everything the Super Admin console shows in the tenant
 * drawer, gathered in one call: profile, plan, licence usage, subscription
 * state, live database statistics and the shop's recent audit trail.
 */
app.get(
  '/api/admin/tenants/:id/details',
  handler(async (req, res) => {
    const tenant = await findTenant({ id: req.params.id });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const [plan, devices, subscription, payments, auditLogs] = await Promise.all([
      getPlan(tenant.plan),
      models.Device.find({ tenantId: { $in: [tenant.tenantId, tenant.id] } }).lean(),
      models.Subscription.findOne({ tenantId: { $in: [tenant.tenantId, tenant.id] } }).sort({ createdAt: -1 }).lean(),
      models.Payment.find({ tenantId: { $in: [tenant.tenantId, tenant.id] } }).sort({ createdAt: -1 }).limit(50).lean(),
      models.AuditLog.find({
        $or: [{ description: new RegExp(escapeRegex(tenant.name)) }, { actor: tenant.email }]
      })
        .sort({ createdAt: -1 })
        .limit(25)
        .lean()
    ]);

    let database = null;
    try {
      const { getTenantDbStats } = require('./tenantDb');
      database = await getTenantDbStats(tenant.dbName);
    } catch (err) {
      console.error('[Tenant Stats Error]:', err.message);
    }

    const expiry = tenant.expiryDate ? new Date(tenant.expiryDate) : null;
    const daysRemaining = expiry ? Math.ceil((expiry - Date.now()) / 86400000) : null;

    res.json({
      success: true,
      data: {
        tenant: { ...tenant, features: resolveTenantFeatures(tenant) },
        plan,
        featureCatalog: FEATURE_CATALOG,
        subscription,
        daysRemaining,
        isExpired: daysRemaining !== null && daysRemaining < 0,
        licence: {
          maxDevices: tenant.maxDevices || plan?.maxDevices || 0,
          activeDevices: devices.filter((d) => d.status === 'active').length,
          totalDevices: devices.length,
          devices
        },
        payments: payments.slice(0, 20),
        revenue: payments
          .filter((p) => p.status === 'PAID' || p.status === 'SUCCESS')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0),
        database,
        auditLogs
      }
    });
  })
);

/** The feature catalogue the plan editor and shop drawer render their toggles from. */
app.get('/api/admin/features', (req, res) => {
  res.json({ success: true, data: FEATURE_CATALOG });
});

// Get Subscription Plans
app.get(
  '/api/admin/plans',
  handler(async (req, res) => {
    const plans = await models.Plan.find().sort({ price: 1 }).lean();
    res.json({ success: true, data: plans });
  })
);

// Update Subscription Plan Details
app.put(
  '/api/admin/plans/:id',
  handler(async (req, res) => {
    const { price, maxDevices, features } = req.body;

    const update = {};
    if (price !== undefined) update.price = Number(price);
    if (maxDevices !== undefined) update.maxDevices = Number(maxDevices);
    if (features) update.features = features;

    const plan = await models.Plan.findOneAndUpdate({ id: req.params.id }, { $set: update }, { new: true, lean: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Subscription plan not found' });

    await addAuditLog('PLAN_UPDATE', actorOf(req), `Updated pricing and options for tier [${plan.name}]`);

    res.json({
      success: true,
      message: `Plan "${plan.name}" updated successfully.`,
      data: plan
    });
  })
);

// Database Health & Pool Diagnostics — read from the tenant databases themselves.
app.get(
  '/api/admin/database/health',
  handler(async (req, res) => {
    const { getTenantDbStats } = require('./tenantProvisioner');
    const tenants = await models.Tenant.find().lean();

    const pools = await Promise.all(
      tenants.map(async (t) => {
        const started = Date.now();
        const stats = await getTenantDbStats(t.dbName);
        return {
          tenantId: t.tenantId,
          name: t.name,
          dbName: t.dbName,
          status: !stats ? 'UNREACHABLE' : t.status === 'active' ? 'HEALTHY' : 'STANDBY',
          provisioned: Boolean(stats),
          collectionsCount: stats?.collections ?? 0,
          sizeMB: stats?.sizeMB ?? 0,
          records: stats?.counts ?? {},
          latencyMs: Date.now() - started
        };
      })
    );

    res.json({
      success: true,
      isMongoMasterConnected: getIsMongoConnected(),
      masterDatabase: getMongoDiagnostics().masterDatabase,
      totalIsolatedPools: pools.length,
      healthyPools: pools.filter((p) => p.status === 'HEALTHY').length,
      totalStorageMB: Math.round(pools.reduce((acc, p) => acc + p.sizeMB, 0) * 100) / 100,
      pools
    });
  })
);

// Audit Logs Endpoint
app.get(
  '/api/admin/audit-logs',
  handler(async (req, res) => {
    const logs = await models.AuditLog.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data: logs });
  })
);

// Platform Settings Endpoints
app.get(
  '/api/admin/settings',
  handler(async (req, res) => {
    const settings = await getSettings();
    res.json({
      success: true,
      data: {
        maintenanceMode: settings.maintenanceMode,
        systemNotification: settings.systemNotification,
        otpExpiryMinutes: settings.otpExpiryMinutes,
        allowRegistration: settings.allowRegistration,
        platformVersion: settings.platformVersion
      }
    });
  })
);

app.put(
  '/api/admin/settings',
  handler(async (req, res) => {
    const { maintenanceMode, systemNotification, otpExpiryMinutes, allowRegistration } = req.body;

    const update = {};
    if (maintenanceMode !== undefined) update.maintenanceMode = Boolean(maintenanceMode);
    if (systemNotification !== undefined) update.systemNotification = systemNotification;
    if (otpExpiryMinutes !== undefined) update.otpExpiryMinutes = Number(otpExpiryMinutes);
    if (allowRegistration !== undefined) update.allowRegistration = Boolean(allowRegistration);

    await models.Setting.updateOne({ key: 'master_settings' }, { $set: update }, { upsert: true });
    const settings = await getSettings();

    await addAuditLog('SETTINGS_UPDATE', actorOf(req), 'Updated platform configuration settings');

    res.json({
      success: true,
      message: 'Platform settings updated successfully.',
      data: {
        maintenanceMode: settings.maintenanceMode,
        systemNotification: settings.systemNotification,
        otpExpiryMinutes: settings.otpExpiryMinutes,
        allowRegistration: settings.allowRegistration,
        platformVersion: settings.platformVersion
      }
    });
  })
);

/* ------------------------------------------------------------------ *
 * SHOP OWNER (POS) AUTHENTICATION — passwordless email + one-time code.
 *
 * The code is stored as a SHA-256 hash in the master database, never in
 * process memory: on a serverless host the request that asks for a code and
 * the one that verifies it are routinely handled by different instances.
 * ------------------------------------------------------------------ */

const TENANT_OTP_SCOPE = 'tenant';
const MAX_OTP_ATTEMPTS = 5;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const sendTenantOtp = handler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email address is required.' });
  }

  // Straight from the master database — the only place a shop is registered.
  const tenant = await models.Tenant.findOne({ email }).lean();
  if (!tenant) {
    await addAuditLog('OTP_FAILED', email, 'OTP requested for non-existent email', 'FAILED');
    return res.status(404).json({
      success: false,
      message: `No shop account found registered under "${email}". Please register via Super Admin or check email.`
    });
  }

  if (tenant.status !== 'active') {
    await addAuditLog('OTP_BLOCKED', email, 'OTP requested for deactivated shop', 'BLOCKED');
    return res.status(403).json({
      success: false,
      message: 'This shop subscription is currently deactivated. Please contact Super Admin.'
    });
  }

  const generatedOtp = String(crypto.randomInt(100000, 1000000));
  const expiryMinutes = await getOtpExpiryMinutes();

  await models.Otp.updateOne(
    { email, scope: TENANT_OTP_SCOPE },
    {
      $set: {
        email,
        scope: TENANT_OTP_SCOPE,
        otpHash: hashOtp(generatedOtp),
        attempts: 0,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000)
      }
    },
    { upsert: true }
  );

  const mailResult = await sendOtpEmail({
    to: tenant.email,
    otp: generatedOtp,
    expiryMinutes,
    purpose: 'tenant',
    recipientLabel: tenant.name
  });

  await addAuditLog(
    'OTP_SENT',
    email,
    mailResult.delivered
      ? 'Emailed 6-digit OTP to registered shop owner'
      : `Generated 6-digit OTP for shop owner (email not delivered: ${mailResult.reason})`,
    mailResult.delivered ? 'SUCCESS' : 'WARNING'
  );

  const exposeCode = !mailResult.delivered && process.env.NODE_ENV !== 'production';

  res.json({
    success: true,
    message: mailResult.delivered
      ? `OTP sent successfully to ${email}.`
      : exposeCode
        ? `OTP generated for ${email}. SMTP is not configured, so the code is shown here for testing.`
        : `OTP generated for ${email}, but the email could not be delivered. Please contact support.`,
    emailDelivered: mailResult.delivered,
    demoOtp: exposeCode ? generatedOtp : undefined,
    tenant: {
      name: tenant.name,
      slug: tenant.slug,
      dbName: tenant.dbName
    }
  });
});

const verifyTenantOtp = handler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP code are required.' });
  }

  const record = await models.Otp.findOne({ email, scope: TENANT_OTP_SCOPE }).lean();
  if (!record) {
    await addAuditLog('OTP_VERIFY_FAILED', email, 'OTP record expired or not requested', 'FAILED');
    return res.status(400).json({ success: false, message: 'No OTP requested for this email or OTP expired.' });
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    await models.Otp.deleteOne({ email, scope: TENANT_OTP_SCOPE });
    await addAuditLog('OTP_VERIFY_FAILED', email, 'OTP code expired before verification', 'FAILED');
    return res.status(400).json({ success: false, message: 'This OTP has expired. Please request a new one.' });
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await models.Otp.deleteOne({ email, scope: TENANT_OTP_SCOPE });
    await addAuditLog('OTP_VERIFY_BLOCKED', email, 'OTP invalidated after too many incorrect attempts', 'BLOCKED');
    return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new OTP.' });
  }

  if (!safeEqual(hashOtp(otp), record.otpHash)) {
    // Counted in the database, so attempts add up across instances.
    await models.Otp.updateOne({ email, scope: TENANT_OTP_SCOPE }, { $inc: { attempts: 1 } });
    await addAuditLog('OTP_VERIFY_FAILED', email, 'Invalid OTP code entered', 'FAILED');
    return res.status(400).json({ success: false, message: 'Invalid OTP code. Please try again.' });
  }

  const tenant = await models.Tenant.findOne({ email }).lean();
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'No shop account found for this email.' });
  }
  if (tenant.status !== 'active') {
    return res.status(403).json({
      success: false,
      message: 'This shop subscription is currently deactivated. Please contact Super Admin.'
    });
  }

  await models.Otp.deleteOne({ email, scope: TENANT_OTP_SCOPE });
  await addAuditLog('OTP_LOGIN_SUCCESS', email, `Shop Owner successfully authenticated into POS session (${tenant.dbName})`);

  const token = jwt.sign(
    {
      tenantId: tenant.tenantId,
      name: tenant.name,
      email: tenant.email,
      dbName: tenant.dbName,
      slug: tenant.slug,
      plan: tenant.plan,
      role: 'Owner'
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    success: true,
    message: 'OTP verified successfully! Logged into POS.',
    token,
    tenant: {
      id: tenant.id,
      tenantId: tenant.tenantId,
      name: tenant.name,
      slug: tenant.slug,
      email: tenant.email,
      phone: tenant.phone,
      dbName: tenant.dbName,
      plan: tenant.plan,
      // Resolved, not raw — a shop still holding a pre-catalogue map would
      // otherwise report modules as off that it can in fact use.
      features: resolveTenantFeatures(tenant)
    }
  });
});

app.post('/api/auth/send-otp', sendTenantOtp);
app.post('/api/auth/verify-otp', verifyTenantOtp);

/**
 * Universal entry points used by both consoles: the address decides which
 * account type is being signed in, looked up in the master database.
 */
app.post(
  '/api/send-otp',
  handler(async (req, res, next) => {
    const admin = await findSuperAdmin(req.body?.email);
    if (admin) {
      req.url = '/send-otp';
      return authRouter(req, res, next);
    }
    return sendTenantOtp(req, res, next);
  })
);

app.post(
  '/api/verify-otp',
  handler(async (req, res, next) => {
    const admin = await findSuperAdmin(req.body?.email);
    if (admin) {
      req.url = '/verify-otp';
      return authRouter(req, res, next);
    }
    return verifyTenantOtp(req, res, next);
  })
);

// --- POS TERMINAL ENDPOINTS ---

// Tenant Resolution Middleware for POS routes
app.use('/api/pos', resolveTenantDb);

// Plan-based feature gate — a shop cannot call into a module its tier excludes.
app.use('/api/pos', enforcePlanFeatures);

// API Routes
app.use('/api/pos', apiRoutes);

// Consolidated Health Check Endpoint
app.get('/api/health', async (req, res) => {
  const connected = await ensureMasterDB();

  let tenantsCount = null;
  let tenantDatabases = [];
  if (connected) {
    try {
      const tenants = await models.Tenant.find({}, { dbName: 1 }).lean();
      tenantsCount = tenants.length;
      tenantDatabases = tenants.map((t) => t.dbName);
    } catch (err) {
      console.error('[Health tenant read error]:', err.message);
    }
  }

  res.status(connected ? 200 : 503).json({
    success: connected,
    service: 'Selsolve Master Unified Backend API',
    mongoMasterConnected: connected,
    mongoDiagnostics: getMongoDiagnostics(),
    smtpConfigured: isSmtpConfigured,
    tenantsCount,
    tenantDatabases,
    superAdminEmail: SEED_SUPER_ADMIN_EMAIL,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// Global Error Handling Middlewares
app.use(notFoundHandler);
app.use(errorHandler);

// Start Server if launched directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 [Selsolve Unified Master Backend] Running on http://localhost:${PORT}`);
    console.log(`🔐 Super Admin Email: ${SEED_SUPER_ADMIN_EMAIL}`);
    console.log(`📧 OTP Email Delivery: ${isSmtpConfigured ? 'Nodemailer SMTP' : 'Console fallback'}`);
    console.log(`🗄️  Master Database: ${getMongoDiagnostics().masterDatabase} (tenant data in isolated tenant_db_* databases)`);
  });
}

module.exports = app;
