const mongoose = require('mongoose');
const { PLAN_DEFAULTS, FEATURE_SCHEMA_VERSION, upgradePlanFeatures } = require('./modules/features');

let isMongoConnected = false;

// Seeded super admin console operators (passwordless — email + OTP only)
const SEED_SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'zunasoftdevelopment@gmail.com').toLowerCase();

// Shared memory store for fast caching & dynamic fallback
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
  tenants: [],
  // Feature lists come from the shared catalogue (modules/features.js) so the
  // plan editor, the POS feature gate and these seeds can never disagree.
  plans: [
    { id: 'starter', name: 'Starter', price: 999, billingCycle: 'Monthly', maxDevices: 2, features: [...PLAN_DEFAULTS.starter], featureSchema: FEATURE_SCHEMA_VERSION },
    { id: 'pro', name: 'Pro Retailer', price: 2499, billingCycle: 'Monthly', maxDevices: 5, features: [...PLAN_DEFAULTS.pro], featureSchema: FEATURE_SCHEMA_VERSION },
    { id: 'enterprise', name: 'Enterprise', price: 19999, billingCycle: 'Yearly', maxDevices: 25, features: [...PLAN_DEFAULTS.enterprise], featureSchema: FEATURE_SCHEMA_VERSION }
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
const addAuditLog = async (action, actor, description, status = 'SUCCESS') => {
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

  if (isMongoConnected) {
    try {
      const AuditLogModel = require('./models/AuditLog.model');
      await AuditLogModel.create(log);
    } catch (err) {
      console.error('[AuditLog DB Error]:', err.message);
    }
  }
  return log;
};

/**
 * One-time upgrade of tenant feature maps written before the feature catalogue.
 * Idempotent — a map already in the current vocabulary is left exactly as is,
 * so a Super Admin's deliberate per-shop choice is never overwritten.
 */
const upgradeLegacyTenantFeatures = async (TenantModel) => {
  const { isLegacyFeatureMap, resolveTenantFeatures } = require('./modules/features');

  const stale = memoryDb.tenants.filter((t) => isLegacyFeatureMap(t.features));
  if (!stale.length) return;

  for (const tenant of stale) {
    const before = Object.values(tenant.features || {}).filter(Boolean).length;
    tenant.features = resolveTenantFeatures(tenant);
    const after = Object.values(tenant.features).filter(Boolean).length;

    try {
      await TenantModel.updateOne({ id: tenant.id }, { $set: { features: tenant.features } });
      console.log(
        `🔧 [Master DB] Upgraded feature map for "${tenant.name}" (${tenant.plan}): ${before} → ${after} enabled.`
      );
    } catch (err) {
      console.error(`[Feature upgrade error for ${tenant.name}]:`, err.message);
    }
  }
};

/** Seed all initial Master Data into MongoDB Atlas */
const seedMasterDB = async () => {
  try {
    const TenantModel = require('./models/Tenant.model');
    const SuperAdminModel = require('./models/SuperAdmin.model');
    const PlanModel = require('./models/Plan.model');
    const SettingModel = require('./models/Setting.model');
    const AuditLogModel = require('./models/AuditLog.model');
    const DeviceModel = require('./models/Device.model');
    const SubscriptionModel = require('./models/Subscription.model');
    const PaymentModel = require('./models/Payment.model');

    // 1. Seed SuperAdmins
    const superAdminCount = await SuperAdminModel.countDocuments();
    if (superAdminCount === 0) {
      await SuperAdminModel.insertMany(memoryDb.superAdmins);
      console.log(`🌱 [Seed] Seeded ${memoryDb.superAdmins.length} Super Admin(s) into MongoDB.`);
    } else {
      const dbAdmins = await SuperAdminModel.find().lean();
      memoryDb.superAdmins = dbAdmins;
    }

    // 2. Seed Tenants
    const tenantCount = await TenantModel.countDocuments();
    if (tenantCount === 0) {
      await TenantModel.insertMany(memoryDb.tenants);
      console.log(`🌱 [Seed] Seeded ${memoryDb.tenants.length} default Tenant(s) into MongoDB.`);
    } else {
      const dbTenants = await TenantModel.find().lean();
      memoryDb.tenants = dbTenants;
      console.log(`🍃 [Master DB] Loaded ${dbTenants.length} Tenant(s) from MongoDB.`);
    }

    // Re-stamp shops still carrying a pre-catalogue feature map.
    //
    // Two things used to conspire here: the map was written in the old six-name
    // vocabulary, and the Tenant schema listed only those six keys, so a wider
    // map could never be saved. Reading such a map literally hides modules the
    // shop's tier actually includes, so widen it to the tier once and store it.
    await upgradeLegacyTenantFeatures(TenantModel);

    // Provision tenant database instances in MongoDB Atlas
    try {
      const { provisionTenantDB } = require('./tenantProvisioner');
      for (const tenant of memoryDb.tenants) {
        if (tenant.dbName) {
          await provisionTenantDB(tenant.dbName, tenant);
        }
      }
    } catch (provErr) {
      console.error('[Tenant Provisioning Error]:', provErr.message);
    }

    // 3. Seed Plans
    const planCount = await PlanModel.countDocuments();
    if (planCount === 0) {
      await PlanModel.insertMany(memoryDb.plans);
      console.log(`🌱 [Seed] Seeded ${memoryDb.plans.length} Plan(s) into MongoDB.`);
    } else {
      // Plans stored before the feature catalogue existed list only a handful of
      // names. Read literally they would now deny modules a paying shop already
      // uses, so they are widened to the tier default and written back once.
      const dbPlans = await PlanModel.find().lean();
      const legacy = dbPlans.filter((p) => p.featureSchema !== FEATURE_SCHEMA_VERSION);
      memoryDb.plans = dbPlans.map(upgradePlanFeatures);

      if (legacy.length) {
        await Promise.all(
          memoryDb.plans.map((plan) =>
            PlanModel.updateOne(
              { id: plan.id },
              { $set: { features: plan.features, featureSchema: FEATURE_SCHEMA_VERSION } }
            ).catch(() => {})
          )
        );
        console.log(`♻️  [Migration] Widened ${legacy.length} legacy plan feature list(s) to the current catalogue.`);
      }
    }

    // 4. Seed Settings
    const settingCount = await SettingModel.countDocuments();
    if (settingCount === 0) {
      await SettingModel.create({ key: 'master_settings', ...memoryDb.settings });
      console.log(`🌱 [Seed] Seeded Master Settings into MongoDB.`);
    } else {
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
    }

    // 5. Seed Audit Logs
    const auditCount = await AuditLogModel.countDocuments();
    if (auditCount === 0) {
      await AuditLogModel.insertMany(memoryDb.auditLogs);
      console.log(`🌱 [Seed] Seeded initial Audit Logs into MongoDB.`);
    } else {
      const dbLogs = await AuditLogModel.find().sort({ createdAt: -1 }).limit(100).lean();
      memoryDb.auditLogs = dbLogs;
    }

    // 6. Sync Devices, Subscriptions, Payments
    const dbDevices = await DeviceModel.find().lean();
    if (dbDevices) memoryDb.devices = dbDevices;

    const dbSubs = await SubscriptionModel.find().lean();
    if (dbSubs) memoryDb.subscriptions = dbSubs;

    const dbPayments = await PaymentModel.find().lean();
    if (dbPayments) memoryDb.payments = dbPayments;

  } catch (err) {
    console.error('⚠️ [Master DB Seed Error]:', err.message);
  }
};

const connectMasterDB = async () => {
  const mongoUri = process.env.ADMIN_BE_URL || process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/selsolve';
  try {
    const conn = await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    isMongoConnected = true;
    console.log(`🍃 [MongoDB Connected] Master DB Host: ${conn.connection.host} | DB Name: ${conn.connection.name}`);

    // Seed data & sync store
    await seedMasterDB();

    return conn;
  } catch (err) {
    isMongoConnected = false;
    console.log(`⚠️ [MongoDB Connection Fallback] ${err.message}`);
    console.log(`   Operating with dynamic in-memory store fallback.`);
    return null;
  }
};

module.exports = {
  connectMasterDB,
  seedMasterDB,
  memoryDb,
  addAuditLog,
  SEED_SUPER_ADMIN_EMAIL,
  getIsMongoConnected: () => isMongoConnected
};
