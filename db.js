/**
 * Master database layer.
 *
 * MongoDB is the only source of truth in this application. There is no
 * in-memory mirror of tenants, plans, settings, devices, subscriptions,
 * payments, audit logs or login codes — every read goes to the master database
 * (`selsolve`) and every write lands there before the response goes out.
 *
 * That rule exists because the backend runs on a serverless host: each request
 * may be served by a different instance with its own fresh process memory. Any
 * value cached in a module-level variable is visible to exactly one instance
 * and invisible to the next, which shows up as a shop "not found" on one
 * request and found on the very next one.
 *
 * A tenant's own operational data lives in its isolated `tenant_db_<slug>`
 * database and is handled by `tenantDb.js`; nothing here touches it.
 */

const mongoose = require('mongoose');
const config = require('./config/config');
const { PLAN_DEFAULTS, FEATURE_SCHEMA_VERSION, upgradePlanFeatures } = require('./modules/features');

// Seeded super admin console operator (passwordless — email + OTP only)
const SEED_SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'zunasoftdevelopment@gmail.com').toLowerCase();

/* ------------------------------------------------------------------ *
 * Models — one place to reach every master collection.
 * ------------------------------------------------------------------ */

const models = {
  Tenant: require('./models/Tenant.model'),
  SuperAdmin: require('./models/SuperAdmin.model'),
  Plan: require('./models/Plan.model'),
  Setting: require('./models/Setting.model'),
  AuditLog: require('./models/AuditLog.model'),
  Device: require('./models/Device.model'),
  Subscription: require('./models/Subscription.model'),
  Payment: require('./models/Payment.model'),
  Otp: require('./models/Otp.model')
};

/* ------------------------------------------------------------------ *
 * Defaults used only to seed an empty master database.
 *
 * These are write-once starting values, not a fallback dataset: once the
 * database holds a row, that row is what every read returns.
 * ------------------------------------------------------------------ */

const DEFAULT_SUPER_ADMIN = {
  id: 'sa_001',
  name: 'Zunasoft Super Admin',
  email: SEED_SUPER_ADMIN_EMAIL,
  role: 'SuperAdmin',
  status: 'active',
  lastLoginAt: null
};

const DEFAULT_PLANS = [
  { id: 'starter', name: 'Starter', price: 999, billingCycle: 'Monthly', maxDevices: 2, features: [...PLAN_DEFAULTS.starter], licenseModel: 'PER_DEVICE', trialDays: 14, isActive: true, featureSchema: FEATURE_SCHEMA_VERSION },
  { id: 'pro', name: 'Pro Retailer', price: 2499, billingCycle: 'Monthly', maxDevices: 5, features: [...PLAN_DEFAULTS.pro], licenseModel: 'PER_DEVICE', trialDays: 0, isActive: true, featureSchema: FEATURE_SCHEMA_VERSION },
  { id: 'enterprise', name: 'Enterprise', price: 19999, billingCycle: 'Yearly', maxDevices: 25, features: [...PLAN_DEFAULTS.enterprise], licenseModel: 'PER_ORGANISATION', trialDays: 0, isActive: true, featureSchema: FEATURE_SCHEMA_VERSION }
];

const DEFAULT_SETTINGS = {
  key: 'master_settings',
  maintenanceMode: false,
  systemNotification: 'Welcome to Zunasoft Smart POS Master Backend!',
  otpExpiryMinutes: 10,
  allowRegistration: true,
  platformVersion: 'v2.5 Enterprise Unified Master'
};

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/** Strip credentials so a URI can be logged or returned over HTTP. */
const maskMongoUri = (uri) => String(uri).replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');

/**
 * Resolve the master connection string and record WHICH variable supplied it.
 * On a serverless host a missing variable silently becomes the localhost
 * default, which then fails with a confusing ECONNREFUSED — so the source name
 * is worth surfacing alongside the error.
 */
const resolveMongoUri = () => {
  const candidates = ['ADMIN_BE_URL', 'MONGO_URI', 'MONGODB_URI'];
  const source = candidates.find((key) => process.env[key]);
  return {
    uri: source ? process.env[source] : config.MONGODB_URI,
    source: source || 'config default (no env var set)'
  };
};

const mongoDiagnostics = {
  uriSource: null,
  uri: null,
  dbName: null,
  lastError: null,
  lastAttemptAt: null,
  connectedAt: null,
  attempts: 0
};

/**
 * The one in-flight connect. Every caller awaits this same promise, so a burst
 * of concurrent requests on a cold instance opens one connection rather than
 * one per request. Cleared on failure so the next request retries.
 */
let connectPromise = null;

const isLive = () => mongoose.connection.readyState === 1;

mongoose.connection.on('disconnected', () => {
  // Drop the memoised promise so the next request reconnects instead of
  // awaiting a connection that is already gone.
  connectPromise = null;
  mongoDiagnostics.lastError = 'Connection to the master database was lost.';
  console.warn('⚠️  [MongoDB] master connection lost — will reconnect on next request.');
});

const connectMasterDB = () => {
  if (connectPromise) return connectPromise;

  const { uri, source } = resolveMongoUri();
  mongoDiagnostics.uriSource = source;
  mongoDiagnostics.uri = maskMongoUri(uri);
  mongoDiagnostics.lastAttemptAt = new Date().toISOString();
  mongoDiagnostics.attempts += 1;

  connectPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS) || 15000,
      // A serverless instance handles few concurrent requests but is recycled
      // often; a small pool keeps Atlas connection counts sane.
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 10
    })
    .then(async (conn) => {
      mongoDiagnostics.lastError = null;
      mongoDiagnostics.connectedAt = new Date().toISOString();
      mongoDiagnostics.dbName = conn.connection.name;
      console.log(`🍃 [MongoDB Connected] Master DB Host: ${conn.connection.host} | DB Name: ${conn.connection.name}`);

      await seedMasterDB();
      return conn;
    })
    .catch((err) => {
      mongoDiagnostics.lastError = err.message;
      connectPromise = null;
      console.error(`❌ [MongoDB] master connection failed: ${err.message}`);
      console.error(`   URI source: ${source} → ${maskMongoUri(uri)}`);
      throw err;
    });

  return connectPromise;
};

/**
 * Guarantee a live master connection before a request reads or writes.
 * Returns false rather than throwing, so callers can answer 503 themselves.
 */
const ensureMasterDB = async () => {
  if (isLive()) return true;
  try {
    await connectMasterDB();
    return isLive();
  } catch {
    return false;
  }
};

/**
 * Route guard: nothing is served from stale process memory, so a request that
 * arrives without a reachable database is refused outright. Answering from a
 * local cache here is what previously made a registered shop look unregistered.
 */
const requireMasterDB = async (req, res, next) => {
  if (await ensureMasterDB()) return next();
  return res.status(503).json({
    success: false,
    code: 'MASTER_DB_UNAVAILABLE',
    message: 'The master database is unreachable. Please try again in a moment.',
    diagnostics: getMongoDiagnostics()
  });
};

/* ------------------------------------------------------------------ *
 * Seeding — idempotent, runs once per connection.
 * ------------------------------------------------------------------ */

/**
 * Re-stamp shops still carrying a pre-catalogue feature map.
 *
 * Such a map was written in the old six-name vocabulary, and reading it
 * literally hides modules the shop's tier actually includes. Widening is
 * idempotent: a map already in the current vocabulary is left exactly as is, so
 * a Super Admin's deliberate per-shop choice is never overwritten.
 */
const upgradeLegacyTenantFeatures = async () => {
  const { isLegacyFeatureMap, resolveTenantFeatures } = require('./modules/features');

  const tenants = await models.Tenant.find().lean();
  const stale = tenants.filter((t) => isLegacyFeatureMap(t.features));

  for (const tenant of stale) {
    const features = resolveTenantFeatures(tenant);
    try {
      await models.Tenant.updateOne({ id: tenant.id }, { $set: { features } });
      console.log(`🔧 [Master DB] Upgraded feature map for "${tenant.name}" (${tenant.plan}).`);
    } catch (err) {
      console.error(`[Feature upgrade error for ${tenant.name}]:`, err.message);
    }
  }
};

/** Create the rows a brand-new platform needs. Never overwrites existing data. */
const seedMasterDB = async () => {
  try {
    // 1. Super Admin console operator
    await models.SuperAdmin.updateOne(
      { email: SEED_SUPER_ADMIN_EMAIL },
      { $setOnInsert: DEFAULT_SUPER_ADMIN },
      { upsert: true }
    );

    // 2. Subscription tiers — inserted if absent, widened if pre-catalogue.
    for (const plan of DEFAULT_PLANS) {
      await models.Plan.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true });
    }

    const legacyPlans = await models.Plan.find({ featureSchema: { $ne: FEATURE_SCHEMA_VERSION } }).lean();
    for (const plan of legacyPlans) {
      const widened = upgradePlanFeatures({ ...plan });
      await models.Plan.updateOne(
        { id: plan.id },
        { $set: { features: widened.features, featureSchema: FEATURE_SCHEMA_VERSION } }
      );
    }
    if (legacyPlans.length) {
      console.log(`♻️  [Migration] Widened ${legacyPlans.length} legacy plan feature list(s) to the current catalogue.`);
    }

    // 3. Platform settings
    await models.Setting.updateOne(
      { key: 'master_settings' },
      { $setOnInsert: DEFAULT_SETTINGS },
      { upsert: true }
    );

    // 4. Shops written before the feature catalogue existed
    await upgradeLegacyTenantFeatures();

    // Tenant databases are provisioned when a shop is created, and lazily on
    // first use (see tenantDb.hydrateTenantStore). Deliberately not done here:
    // walking every tenant on boot delays the first request by seconds.
  } catch (err) {
    console.error('⚠️ [Master DB Seed Error]:', err.message);
  }
};

/* ------------------------------------------------------------------ *
 * Shared master-data helpers
 * ------------------------------------------------------------------ */

/** Platform settings, straight from the database. */
const getSettings = async () => {
  const doc = await models.Setting.findOne({ key: 'master_settings' }).lean();
  return { ...DEFAULT_SETTINGS, ...(doc || {}) };
};

const getOtpExpiryMinutes = async () => {
  try {
    const settings = await getSettings();
    return Number(settings.otpExpiryMinutes) || 10;
  } catch {
    return 10;
  }
};

/** Every subscription tier, ordered cheapest first. */
const getPlans = async () => models.Plan.find().sort({ price: 1 }).lean();

const getPlan = async (planId) => (planId ? models.Plan.findOne({ id: planId }).lean() : null);

/** A shop, by any of the three identifiers the app uses for one. */
const findTenant = async ({ id, tenantId, email, dbName } = {}) => {
  const or = [];
  if (id) or.push({ id }, { tenantId: id });
  if (tenantId) or.push({ tenantId });
  if (email) or.push({ email: String(email).trim().toLowerCase() });
  if (dbName) or.push({ dbName });
  if (!or.length) return null;
  return models.Tenant.findOne({ $or: or }).lean();
};

/* ------------------------------------------------------------------ *
 * Audit trail
 * ------------------------------------------------------------------ */

/**
 * Record an action in the master audit log.
 *
 * Awaitable, and awaited by the handlers that call it: a log written after the
 * response has gone out is not guaranteed to survive on a serverless host,
 * where the instance can be frozen the moment the response is flushed.
 */
const addAuditLog = async (action, actor, description, status = 'SUCCESS') => {
  const log = {
    id: `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    actor: actor || 'System',
    description,
    ip: '127.0.0.1',
    status
  };

  try {
    if (await ensureMasterDB()) await models.AuditLog.create(log);
  } catch (err) {
    // An audit write must never take down the operation it is describing.
    console.error('[AuditLog DB Error]:', err.message);
  }

  return log;
};

const getMongoDiagnostics = () => ({
  ...mongoDiagnostics,
  readyState: mongoose.connection.readyState,
  masterDatabase: mongoose.connection.name || mongoDiagnostics.dbName || 'selsolve'
});

module.exports = {
  models,
  connectMasterDB,
  ensureMasterDB,
  requireMasterDB,
  seedMasterDB,
  addAuditLog,
  getSettings,
  getOtpExpiryMinutes,
  getPlans,
  getPlan,
  findTenant,
  SEED_SUPER_ADMIN_EMAIL,
  DEFAULT_PLANS,
  getIsMongoConnected: () => isLive(),
  getMongoDiagnostics
};
