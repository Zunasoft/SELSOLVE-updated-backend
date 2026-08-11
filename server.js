/**
 * Selsolve — Smart Retail POS & Super Admin Unified Master Backend Server.
 * Clean, organized architecture with 1 Master Database + Multi-tenant dynamic DB isolation.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const config = require('./config/config');
const { connectMasterDB, memoryDb, addAuditLog, SEED_SUPER_ADMIN_EMAIL, getIsMongoConnected } = require('./db');
const { authRouter, requireSuperAdmin } = require('./auth');
const { sendOtpEmail, verifyMailer, isSmtpConfigured } = require('./mailer');
const licensingModule = require('./modules/licensing');
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
const { tenantDatabases } = require('./store');

const app = express();
const PORT = process.env.PORT || config.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_zunasoft_2026';

// Initialize Master DB Connection & Mailer Transport
connectMasterDB();
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

// Static uploads serving for Multer images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- SUPER ADMIN AUTHENTICATION (public: email + OTP) ---
app.use('/api/admin/auth', authRouter);

// Everything else under /api/admin requires a valid Super Admin session token.
app.use('/api/admin', requireSuperAdmin);

// Device management, subscriptions, plan catalogue and Razorpay payments
app.use('/api/admin', licensingModule);

// --- SUPER ADMIN TENANT MANAGEMENT ENDPOINTS (protected) ---
const actorOf = (req) => req.admin?.email || 'SuperAdmin';

// Get Overview Stats
app.get('/api/admin/stats', (req, res) => {
  const totalShops = memoryDb.tenants.length;
  const activeShops = memoryDb.tenants.filter(t => t.status === 'active').length;
  const inactiveShops = memoryDb.tenants.filter(t => t.status === 'inactive').length;
  const totalRevenue = memoryDb.tenants.reduce((acc, t) => {
    const plan = memoryDb.plans.find(p => p.id === t.plan);
    return acc + (plan ? plan.price : 0);
  }, 0);

  res.json({
    success: true,
    data: {
      totalShops,
      activeShops,
      inactiveShops,
      mrr: totalRevenue,
      databaseStatus: 'Healthy (Multi-Tenant Isolated DB Pool)'
    }
  });
});

// Get Tenants List
app.get('/api/admin/tenants', async (req, res) => {
  if (getIsMongoConnected()) {
    try {
      const TenantModel = require('./models/Tenant.model');
      const dbTenants = await TenantModel.find().lean();
      if (dbTenants && dbTenants.length > 0) {
        memoryDb.tenants = dbTenants;
      }
    } catch (err) {
      console.error('[Tenant DB Fetch Error]:', err.message);
    }
  }
  res.json({
    success: true,
    data: memoryDb.tenants
  });
});

/**
 * Derive a database name that no existing shop is already using.
 * Two shops with similar names ("SB Enterprises" / "S.B. Enterprises") would
 * otherwise slug to the same value and end up sharing one database.
 */
const uniqueSlugFor = (name) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'shop';
  const taken = new Set(memoryDb.tenants.flatMap(t => [t.slug, t.tenantId].filter(Boolean)));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
};

// Create New Tenant Shop (Provisions unique DB)
app.post('/api/admin/tenants', async (req, res) => {
  const { name, email, phone, plan, maxDevices } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Shop name and email are required' });
  }

  const existing = memoryDb.tenants.find(t => String(t.email).toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(400).json({ success: false, message: 'A shop with this email already exists.' });
  }

  const slug = uniqueSlugFor(name);
  const tenantId = slug;
  const dbName = `tenant_db_${slug}`;

  const newTenant = {
    id: `t_${Date.now()}`,
    tenantId,
    name,
    slug,
    email: email.toLowerCase(),
    phone: phone || '+91 9000000000',
    dbName,
    status: 'active',
    plan: plan || 'starter',
    expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    maxDevices: maxDevices || 2,
    // The tier the shop was sold decides which modules it can open. Stamped at
    // provisioning time so a later edit to the plan never silently revokes a
    // capability the shop is already using — that takes an explicit plan change.
    features: featuresForPlan(
      memoryDb.plans.find((p) => p.id === (plan || 'starter')),
      plan || 'starter'
    ),
    createdAt: new Date().toISOString()
  };

  memoryDb.tenants.push(newTenant);

  let provisioned = false;
  if (getIsMongoConnected()) {
    try {
      // Master DB records who the tenant is...
      const TenantModel = require('./models/Tenant.model');
      await TenantModel.findOneAndUpdate({ id: newTenant.id }, newTenant, { upsert: true, new: true });

      // ...and the tenant's own database is created and seeded here.
      const { provisionTenantDB } = require('./tenantProvisioner');
      const result = await provisionTenantDB(dbName, newTenant);
      provisioned = Boolean(result);
    } catch (dbErr) {
      console.error('[Tenant provisioning error]:', dbErr.message);
      memoryDb.tenants = memoryDb.tenants.filter(t => t.id !== newTenant.id);
      addAuditLog('TENANT_PROVISION_FAILED', actorOf(req), `Failed to provision "${name}": ${dbErr.message}`, 'FAILED');
      return res.status(500).json({
        success: false,
        message: `Could not provision the isolated database for "${name}". ${dbErr.message}`
      });
    }
  }

  console.log(`[Super Admin] Provisioned new tenant DB: ${dbName} for shop "${name}"`);
  addAuditLog('TENANT_PROVISIONED', actorOf(req), `Provisioned new isolated DB ${dbName} for "${name}"`);

  res.status(201).json({
    success: true,
    message: provisioned
      ? `Shop created and isolated database (${dbName}) provisioned successfully.`
      : `Shop created. Database (${dbName}) will be provisioned once MongoDB is reachable.`,
    data: newTenant
  });
});

// Toggle Tenant Status (Activate / Deactivate)
app.patch('/api/admin/tenants/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const tenant = memoryDb.tenants.find(t => t.id === id || t.tenantId === id);
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'Tenant not found' });
  }

  tenant.status = status;

  if (getIsMongoConnected()) {
    try {
      const TenantModel = require('./models/Tenant.model');
      await TenantModel.findOneAndUpdate({ id: tenant.id }, tenant, { upsert: true, new: true });
    } catch (dbErr) {
      console.error('[Tenant DB Sync Error]:', dbErr.message);
    }
  }

  addAuditLog('TENANT_STATUS_CHANGE', actorOf(req), `Changed status of "${tenant.name}" to ${status.toUpperCase()}`);

  res.json({
    success: true,
    message: `Tenant "${tenant.name}" status updated to ${status}`,
    data: tenant
  });
});

// Update Tenant Profile Details
app.put('/api/admin/tenants/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, plan, maxDevices, expiryDate, features } = req.body;

  const tenant = memoryDb.tenants.find(t => t.id === id || t.tenantId === id);
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'Tenant not found' });
  }

  if (name) tenant.name = name;
  if (phone) tenant.phone = phone;
  if (email) tenant.email = String(email).toLowerCase();

  // Moving to a different tier re-derives the feature set from that tier.
  if (plan && plan !== tenant.plan) {
    tenant.plan = plan;
    tenant.features = featuresForPlan(memoryDb.plans.find((p) => p.id === plan), plan);
  }

  // A per-shop override always wins over the tier default — this is how a
  // Super Admin grants one shop a capability its plan does not normally carry.
  if (features) tenant.features = normaliseFeatures(features, tenant.plan);

  if (maxDevices) tenant.maxDevices = parseInt(maxDevices) || tenant.maxDevices;
  if (expiryDate) tenant.expiryDate = expiryDate;

  if (getIsMongoConnected()) {
    try {
      const TenantModel = require('./models/Tenant.model');
      await TenantModel.findOneAndUpdate({ id: tenant.id }, tenant, { upsert: true, new: true });
    } catch (dbErr) {
      console.error('[Tenant DB Sync Error]:', dbErr.message);
    }
  }

  addAuditLog('TENANT_EDIT', actorOf(req), `Updated shop settings & plan for "${tenant.name}" (${tenant.plan.toUpperCase()})`);

  res.json({
    success: true,
    message: `Updated tenant profile for ${tenant.name}`,
    data: tenant
  });
});

/**
 * View Shop Details — everything the Super Admin console shows in the tenant
 * drawer, gathered in one call: profile, plan, licence usage, subscription
 * state, live database statistics and the shop's recent audit trail.
 */
app.get('/api/admin/tenants/:id/details', async (req, res) => {
  const { id } = req.params;
  const tenant = memoryDb.tenants.find(t => t.id === id || t.tenantId === id);
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'Tenant not found' });
  }

  const plan = memoryDb.plans.find(p => p.id === tenant.plan) || null;
  const devices = (memoryDb.devices || []).filter(d => d.tenantId === tenant.tenantId || d.tenantId === tenant.id);
  const subscription = (memoryDb.subscriptions || []).find(
    s => s.tenantId === tenant.tenantId || s.tenantId === tenant.id
  ) || null;
  const payments = (memoryDb.payments || []).filter(
    p => p.tenantId === tenant.tenantId || p.tenantId === tenant.id
  );

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
        activeDevices: devices.filter(d => d.status === 'active').length,
        totalDevices: devices.length,
        devices
      },
      payments: payments.slice(0, 20),
      revenue: payments
        .filter(p => p.status === 'PAID' || p.status === 'SUCCESS')
        .reduce((sum, p) => sum + Number(p.amount || 0), 0),
      database,
      auditLogs: (memoryDb.auditLogs || [])
        .filter(l => (l.description || '').includes(tenant.name) || l.actor === tenant.email)
        .slice(0, 25)
    }
  });
});

/** The feature catalogue the plan editor and shop drawer render their toggles from. */
app.get('/api/admin/features', (req, res) => {
  res.json({ success: true, data: FEATURE_CATALOG });
});

// Get Subscription Plans
app.get('/api/admin/plans', async (req, res) => {
  if (getIsMongoConnected()) {
    try {
      const PlanModel = require('./models/Plan.model');
      const dbPlans = await PlanModel.find().lean();
      if (dbPlans && dbPlans.length > 0) memoryDb.plans = dbPlans;
    } catch (err) {
      console.error('[Plan DB Fetch Error]:', err.message);
    }
  }
  res.json({
    success: true,
    data: memoryDb.plans
  });
});

// Update Subscription Plan Details
app.put('/api/admin/plans/:id', async (req, res) => {
  const { id } = req.params;
  const { price, maxDevices, features } = req.body;

  const plan = memoryDb.plans.find(p => p.id === id);
  if (!plan) {
    return res.status(404).json({ success: false, message: 'Subscription plan not found' });
  }

  if (price !== undefined) plan.price = Number(price);
  if (maxDevices !== undefined) plan.maxDevices = Number(maxDevices);
  if (features) plan.features = features;

  if (getIsMongoConnected()) {
    try {
      const PlanModel = require('./models/Plan.model');
      await PlanModel.findOneAndUpdate({ id: plan.id }, plan, { upsert: true, new: true });
    } catch (dbErr) {
      console.error('[Plan DB Sync Error]:', dbErr.message);
    }
  }

  addAuditLog('PLAN_UPDATE', actorOf(req), `Updated pricing and options for tier [${plan.name}]`);

  res.json({
    success: true,
    message: `Plan "${plan.name}" updated successfully.`,
    data: plan
  });
});

// Database Health & Pool Diagnostics — read from the tenant databases themselves.
app.get('/api/admin/database/health', async (req, res) => {
  const { getTenantDbStats } = require('./tenantProvisioner');

  const pools = await Promise.all(
    memoryDb.tenants.map(async (t) => {
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
    masterDatabase: 'selsolve',
    totalIsolatedPools: pools.length,
    healthyPools: pools.filter(p => p.status === 'HEALTHY').length,
    totalStorageMB: Math.round(pools.reduce((acc, p) => acc + p.sizeMB, 0) * 100) / 100,
    pools
  });
});

// Audit Logs Endpoint
app.get('/api/admin/audit-logs', async (req, res) => {
  if (getIsMongoConnected()) {
    try {
      const AuditLogModel = require('./models/AuditLog.model');
      const dbLogs = await AuditLogModel.find().sort({ createdAt: -1 }).limit(100).lean();
      if (dbLogs && dbLogs.length > 0) memoryDb.auditLogs = dbLogs;
    } catch (err) {
      console.error('[AuditLog DB Fetch Error]:', err.message);
    }
  }
  res.json({
    success: true,
    data: memoryDb.auditLogs || []
  });
});

// Platform Settings Endpoints
app.get('/api/admin/settings', async (req, res) => {
  if (getIsMongoConnected()) {
    try {
      const SettingModel = require('./models/Setting.model');
      const dbSetting = await SettingModel.findOne({ key: 'master_settings' }).lean();
      if (dbSetting) {
        memoryDb.settings = {
          maintenanceMode: dbSetting.maintenanceMode,
          systemNotification: dbSetting.systemNotification,
          otpExpiryMinutes: dbSetting.otpExpiryMinutes,
          allowRegistration: dbSetting.allowRegistration,
          platformVersion: dbSetting.platformVersion
        };
      }
    } catch (err) {
      console.error('[Setting DB Fetch Error]:', err.message);
    }
  }
  res.json({
    success: true,
    data: memoryDb.settings || {}
  });
});

app.put('/api/admin/settings', async (req, res) => {
  const { maintenanceMode, systemNotification, otpExpiryMinutes } = req.body;
  
  if (memoryDb.settings) {
    if (maintenanceMode !== undefined) memoryDb.settings.maintenanceMode = maintenanceMode;
    if (systemNotification !== undefined) memoryDb.settings.systemNotification = systemNotification;
    if (otpExpiryMinutes !== undefined) memoryDb.settings.otpExpiryMinutes = Number(otpExpiryMinutes);
  }

  if (getIsMongoConnected()) {
    try {
      const SettingModel = require('./models/Setting.model');
      await SettingModel.findOneAndUpdate({ key: 'master_settings' }, memoryDb.settings, { upsert: true, new: true });
    } catch (dbErr) {
      console.error('[Setting DB Sync Error]:', dbErr.message);
    }
  }

  addAuditLog('SETTINGS_UPDATE', actorOf(req), 'Updated platform configuration settings');

  res.json({
    success: true,
    message: 'Platform settings updated successfully.',
    data: memoryDb.settings
  });
});

// --- UNIVERSAL FALLBACK OTP ROUTE HANDLERS (/api/send-otp & /api/verify-otp) ---
// Delegates automatically based on whether the email belongs to Super Admin or Shop Tenant.
app.post('/api/send-otp', (req, res, next) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const isAdmin = memoryDb.superAdmins.some((a) => a.email.toLowerCase() === email);
  if (isAdmin) {
    req.url = '/send-otp';
    return authRouter(req, res, next);
  }
  req.url = '/api/auth/send-otp';
  return app._router.handle(req, res, next);
});

app.post('/api/verify-otp', (req, res, next) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const isAdmin = memoryDb.superAdmins.some((a) => a.email.toLowerCase() === email);
  if (isAdmin) {
    req.url = '/verify-otp';
    return authRouter(req, res, next);
  }
  req.url = '/api/auth/verify-otp';
  return app._router.handle(req, res, next);
});

// --- PASSWORDLESS EMAIL + OTP AUTHENTICATION ENDPOINTS FOR TENANTS ---

// Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email address is required.' });
  }

  const tenant = memoryDb.tenants.find(t => t.email.toLowerCase() === email.toLowerCase().trim());
  if (!tenant) {
    addAuditLog('OTP_FAILED', email, 'OTP requested for non-existent email', 'FAILED');
    return res.status(404).json({
      success: false,
      message: `No shop account found registered under "${email}". Please register via Super Admin or check email.`
    });
  }

  if (tenant.status !== 'active') {
    addAuditLog('OTP_BLOCKED', email, 'OTP requested for deactivated shop', 'BLOCKED');
    return res.status(403).json({
      success: false,
      message: 'This shop subscription is currently deactivated. Please contact Super Admin.'
    });
  }

  const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiryMinutes = Number(memoryDb.settings?.otpExpiryMinutes) || 10;

  const otpRecord = {
    email: email.toLowerCase(),
    otp: generatedOtp,
    expiresAt: Date.now() + expiryMinutes * 60 * 1000
  };
  const existingOtpIdx = memoryDb.otps.findIndex(o => o.email.toLowerCase() === email.toLowerCase());
  if (existingOtpIdx >= 0) {
    memoryDb.otps[existingOtpIdx] = otpRecord;
  } else {
    memoryDb.otps.push(otpRecord);
  }

  const mailResult = await sendOtpEmail({
    to: tenant.email,
    otp: generatedOtp,
    expiryMinutes,
    purpose: 'tenant',
    recipientLabel: tenant.name
  });

  addAuditLog(
    'OTP_SENT',
    email,
    mailResult.delivered
      ? 'Emailed 6-digit OTP to registered shop owner'
      : `Generated 6-digit OTP for shop owner (email not delivered: ${mailResult.reason})`,
    mailResult.delivered ? 'SUCCESS' : 'WARNING'
  );

  console.log(`[OTP Verification] Generated OTP [${generatedOtp}] for email: ${email}`);

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

// Verify OTP & Grant Session Token
app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP code are required.' });
  }

  const record = memoryDb.otps.find(o => o.email.toLowerCase() === email.toLowerCase().trim());
  if (!record) {
    addAuditLog('OTP_VERIFY_FAILED', email, 'OTP record expired or not requested', 'FAILED');
    return res.status(400).json({ success: false, message: 'No OTP requested for this email or OTP expired.' });
  }

  if (record.expiresAt < Date.now()) {
    memoryDb.otps = memoryDb.otps.filter(o => o.email !== record.email);
    addAuditLog('OTP_VERIFY_FAILED', email, 'OTP code expired before verification', 'FAILED');
    return res.status(400).json({ success: false, message: 'This OTP has expired. Please request a new one.' });
  }

  if (record.otp !== otp.trim()) {
    addAuditLog('OTP_VERIFY_FAILED', email, 'Invalid OTP code entered', 'FAILED');
    return res.status(400).json({ success: false, message: 'Invalid OTP code. Please try again.' });
  }

  const tenant = memoryDb.tenants.find(t => t.email.toLowerCase() === email.toLowerCase().trim());
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'No shop account found for this email.' });
  }

  memoryDb.otps = memoryDb.otps.filter(o => o.email !== record.email);
  addAuditLog('OTP_LOGIN_SUCCESS', email, `Shop Owner successfully authenticated into POS session (${tenant.dbName})`);

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

// --- POS TERMINAL ENDPOINTS ---

// Tenant Resolution Middleware for POS routes
app.use('/api/pos', resolveTenantDb);

// A shop may only reach the modules its subscription tier includes.
app.use('/api/pos', enforcePlanFeatures);

// API Routes
app.use('/api/pos', apiRoutes);

// Consolidated Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'Selsolve Master Unified Backend API',
    mongoMasterConnected: getIsMongoConnected(),
    smtpConfigured: isSmtpConfigured,
    tenantsCount: memoryDb.tenants.length,
    activeTenants: Object.keys(tenantDatabases),
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
    console.log(`🛒 Dynamic Tenant Databases Ready: ${memoryDb.tenants.map(t => t.dbName).join(', ')}`);
  });
}

module.exports = app;
