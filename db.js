const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI

let isMongoConnected = false;

// Seeded super admin console operators (passwordless — email + OTP only)
const SEED_SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'zunasoftdevelopment@gmail.com').toLowerCase();

// Shared memory store for instant out-of-the-box demoing without mandatory mongo daemon setup
const memoryDb = {
  superAdmins: [
    {
      id: 'sa_001',
      name: 'Zunasoft Super Admin',
      email: SEED_SUPER_ADMIN_EMAIL,
      role: 'SuperAdmin',
      status: 'active',
      lastLoginAt: null,
      createdAt: new Date().toISOString()
    }
  ],
  adminOtps: [],
  tenants: [
    {
      id: 't_001',
      tenantId: 'freshmart',
      name: 'FreshMart Supermarket',
      slug: 'freshmart',
      email: 'owner@freshmart.com',
      phone: '+91 9876543210',
      dbName: 'tenant_db_freshmart',
      status: 'active',
      plan: 'pro',
      expiryDate: '2027-12-31',
      maxDevices: 5,
      features: { billing: true, inventory: true, purchases: true, reports: true, compositeItems: true, tableMgmt: true },
      createdAt: new Date().toISOString()
    },
    {
      id: 't_002',
      tenantId: 'bakers',
      name: "Baker's Delight Bakery",
      slug: 'bakers',
      email: 'contact@bakersdelight.com',
      phone: '+91 9812345678',
      dbName: 'tenant_db_bakers',
      status: 'active',
      plan: 'starter',
      expiryDate: '2027-06-30',
      maxDevices: 2,
      features: { billing: true, inventory: true, purchases: false, reports: true, compositeItems: true, tableMgmt: false },
      createdAt: new Date().toISOString()
    }
  ],
  plans: [
    { id: 'starter', name: 'Starter', price: 999, billingCycle: 'Monthly', maxDevices: 2, features: ['billing', 'inventory', 'reports'] },
    { id: 'pro', name: 'Pro Retailer', price: 2499, billingCycle: 'Monthly', maxDevices: 5, features: ['billing', 'inventory', 'purchases', 'reports', 'compositeItems', 'tableMgmt'] },
    { id: 'enterprise', name: 'Enterprise', price: 19999, billingCycle: 'Yearly', maxDevices: 25, features: ['billing', 'inventory', 'purchases', 'reports', 'compositeItems', 'tableMgmt', 'multiUser'] }
  ],
  otps: [],
  auditLogs: [
    {
      id: 'log_1',
      timestamp: new Date(Date.now() - 3600000 * 5).toISOString(),
      action: 'TENANT_PROVISIONED',
      actor: 'SuperAdmin',
      description: 'Provisioned new isolated DB tenant_db_freshmart for FreshMart Supermarket',
      ip: '127.0.0.1',
      status: 'SUCCESS'
    },
    {
      id: 'log_2',
      timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
      action: 'OTP_REQUESTED',
      actor: 'owner@freshmart.com',
      description: 'Requested passwordless email OTP verification token',
      ip: '127.0.0.1',
      status: 'SUCCESS'
    },
    {
      id: 'log_3',
      timestamp: new Date(Date.now() - 3600000 * 1).toISOString(),
      action: 'TENANT_PROVISIONED',
      actor: 'SuperAdmin',
      description: "Provisioned new isolated DB tenant_db_bakers for Baker's Delight Bakery",
      ip: '127.0.0.1',
      status: 'SUCCESS'
    }
  ],
  settings: {
    maintenanceMode: false,
    systemNotification: 'Welcome to Zunasoft Smart POS Master Backend!',
    otpExpiryMinutes: 10,
    allowRegistration: true,
    platformVersion: 'v2.5 Enterprise Unified Master'
  },
  devices: [],
  subscriptions: [],
  payments: []
};

// Audit Logging Helper
const addAuditLog = (action, actor, description, status = 'SUCCESS') => {
  if (!memoryDb.auditLogs) memoryDb.auditLogs = [];
  const log = {
    id: `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    actor,
    description,
    ip: '127.0.0.1',
    status
  };
  memoryDb.auditLogs.unshift(log);
  if (memoryDb.auditLogs.length > 100) memoryDb.auditLogs.pop();
  return log;
};

const connectMasterDB = async () => {
  try {
    const conn = await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    isMongoConnected = true;
    console.log(`[Master Backend] Connected to MongoDB Master Database`);

    // Load tenants from MongoDB
    try {
      const TenantModel = require('./models/Tenant.model');
      const dbTenants = await TenantModel.find().lean();
      if (dbTenants && dbTenants.length > 0) {
        const dbTenantEmails = new Set(dbTenants.map(t => (t.email || '').toLowerCase()));
        const existingMemoryTenants = memoryDb.tenants.filter(t => !dbTenantEmails.has((t.email || '').toLowerCase()));
        memoryDb.tenants = [...existingMemoryTenants, ...dbTenants];
        console.log(`[Master Backend] Loaded ${dbTenants.length} tenants from MongoDB into memory store.`);
      }
    } catch (dbErr) {
      console.error('[Master Backend] Error loading tenants from DB:', dbErr.message);
    }

    return conn;
  } catch (err) {
    isMongoConnected = false;
    console.log(`[Master Backend] Local MongoDB daemon not active. Operating with dynamic fallback memory store.`);
    return null;
  }
};

module.exports = {
  connectMasterDB,
  memoryDb,
  addAuditLog,
  SEED_SUPER_ADMIN_EMAIL,
  getIsMongoConnected: () => isMongoConnected
};
