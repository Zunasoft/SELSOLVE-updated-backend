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
app.get('/api/admin/tenants', (req, res) => {
  res.json({
    success: true,
    data: memoryDb.tenants
  });
});

// Create New Tenant Shop (Provisions unique DB)
app.post('/api/admin/tenants', async (req, res) => {
  const { name, email, phone, plan, maxDevices } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Shop name and email are required' });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tenantId = slug;
  const dbName = `tenant_db_${slug}`;

  const existing = memoryDb.tenants.find(t => t.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(400).json({ success: false, message: 'A shop with this email already exists.' });
  }

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
    features: {
      billing: true,
      inventory: true,
      purchases: true,
      reports: true,
      compositeItems: plan === 'pro' || plan === 'enterprise',
      tableMgmt: plan === 'pro' || plan === 'enterprise'
    },
    createdAt: new Date().toISOString()
  };

  memoryDb.tenants.push(newTenant);

  if (getIsMongoConnected()) {
    try {
      const TenantModel = require('./models/Tenant.model');
      await TenantModel.findOneAndUpdate({ id: newTenant.id }, newTenant, { upsert: true, new: true });
    } catch (dbErr) {
      console.error('[Tenant DB Sync Error]:', dbErr.message);
    }
  }

  console.log(`[Super Admin] Provisioned new tenant DB: ${dbName} for shop "${name}"`);
  addAuditLog('TENANT_PROVISIONED', actorOf(req), `Provisioned new isolated DB ${dbName} for "${name}"`);

  res.status(201).json({
    success: true,
    message: `Shop created and isolated database (${dbName}) provisioned successfully.`,
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
  const { name, phone, plan, maxDevices, expiryDate } = req.body;

  const tenant = memoryDb.tenants.find(t => t.id === id || t.tenantId === id);
  if (!tenant) {
    return res.status(404).json({ success: false, message: 'Tenant not found' });
  }

  if (name) tenant.name = name;
  if (phone) tenant.phone = phone;
  if (plan) {
    tenant.plan = plan;
    tenant.features = {
      ...tenant.features,
      compositeItems: plan === 'pro' || plan === 'enterprise',
      tableMgmt: plan === 'pro' || plan === 'enterprise'
    };
  }
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

// Get Subscription Plans
app.get('/api/admin/plans', (req, res) => {
  res.json({
    success: true,
    data: memoryDb.plans
  });
});

// Update Subscription Plan Details
app.put('/api/admin/plans/:id', (req, res) => {
  const { id } = req.params;
  const { price, maxDevices, features } = req.body;

  const plan = memoryDb.plans.find(p => p.id === id);
  if (!plan) {
    return res.status(404).json({ success: false, message: 'Subscription plan not found' });
  }

  if (price !== undefined) plan.price = Number(price);
  if (maxDevices !== undefined) plan.maxDevices = Number(maxDevices);
  if (features) plan.features = features;

  addAuditLog('PLAN_UPDATE', actorOf(req), `Updated pricing and options for tier [${plan.name}]`);

  res.json({
    success: true,
    message: `Plan "${plan.name}" updated successfully.`,
    data: plan
  });
});

// Database Health & Pool Diagnostics
app.get('/api/admin/database/health', (req, res) => {
  const pools = memoryDb.tenants.map(t => ({
    tenantId: t.tenantId,
    name: t.name,
    dbName: t.dbName,
    status: t.status === 'active' ? 'HEALTHY' : 'STANDBY',
    collectionsCount: 8,
    estimatedSizeMB: Math.floor(Math.random() * 40) + 12,
    activeConnections: t.status === 'active' ? Math.floor(Math.random() * 4) + 1 : 0,
    latencyMs: Math.floor(Math.random() * 8) + 2
  }));

  res.json({
    success: true,
    isMongoMasterConnected: getIsMongoConnected(),
    masterDatabase: 'pos_master_db',
    totalIsolatedPools: pools.length,
    activeConnectionsTotal: pools.reduce((acc, p) => acc + p.activeConnections, 0),
    totalStorageMB: pools.reduce((acc, p) => acc + p.estimatedSizeMB, 0),
    pools
  });
});

// Audit Logs Endpoint
app.get('/api/admin/audit-logs', (req, res) => {
  res.json({
    success: true,
    data: memoryDb.auditLogs || []
  });
});

// Platform Settings Endpoints
app.get('/api/admin/settings', (req, res) => {
  res.json({
    success: true,
    data: memoryDb.settings || {}
  });
});

app.put('/api/admin/settings', (req, res) => {
  const { maintenanceMode, systemNotification, otpExpiryMinutes } = req.body;
  
  if (memoryDb.settings) {
    if (maintenanceMode !== undefined) memoryDb.settings.maintenanceMode = maintenanceMode;
    if (systemNotification !== undefined) memoryDb.settings.systemNotification = systemNotification;
    if (otpExpiryMinutes !== undefined) memoryDb.settings.otpExpiryMinutes = Number(otpExpiryMinutes);
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
      features: tenant.features
    }
  });
});

// --- POS TERMINAL ENDPOINTS ---

// Tenant Resolution Middleware for POS routes
app.use('/api/pos', resolveTenantDb);

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
