
const crypto = require('crypto');
const mongoose = require('mongoose');
const { emptyStore, defaultSettings } = require('./store');

const ARRAY_COLLECTIONS = [
  { key: 'categories', collection: 'categories', idField: 'id' },
  { key: 'products', collection: 'products', idField: 'id' },
  { key: 'customers', collection: 'customers', idField: 'id' },
  { key: 'vendors', collection: 'vendors', idField: 'id' },
  { key: 'warehouses', collection: 'warehouses', idField: 'id' },
  { key: 'priceSheets', collection: 'pricesheets', idField: 'id' },
  { key: 'users', collection: 'users', idField: 'id' },
  { key: 'tables', collection: 'tables', idField: 'id' },
  { key: 'recipes', collection: 'recipes', idField: 'productId' },
  { key: 'heldBills', collection: 'heldbills', idField: 'id' },
  { key: 'purchases', collection: 'purchases', idField: 'id' },
  { key: 'accounts', collection: 'accounts', idField: 'id' },
  { key: 'reconciliations', collection: 'reconciliations', idField: 'id' },
  { key: 'incomes', collection: 'incomes', idField: 'id' },
  { key: 'expenses', collection: 'expenses', idField: 'id' },
  { key: 'receipts', collection: 'receipts', idField: 'id' },
  { key: 'payments', collection: 'payments', idField: 'id' },
  { key: 'transfers', collection: 'transfers', idField: 'id' },
  { key: 'sessions', collection: 'sessions', idField: 'id' },

  // Append-only ledgers: rows are never removed, only added or amended.
  { key: 'orders', collection: 'sales', idField: 'orderId', appendOnly: true, sort: { date: -1 } },
  { key: 'journal', collection: 'journal', idField: 'id', appendOnly: true, sort: { date: -1 } },
  { key: 'stockMovements', collection: 'stockmovements', idField: 'id', appendOnly: true, sort: { timestamp: -1 }, limit: 2000 }
];

/** Singleton values, all kept as one document each in the `meta` collection. */
const META_KEYS = ['settings', 'session', 'voucherCounters', 'units', 'customerGroups'];

const META_COLLECTION = 'meta';
const PROVISION_KEY = '__provisioned';

/* ------------------------------------------------------------------ *
 * Connection helpers
 * ------------------------------------------------------------------ */

const isConnected = () => mongoose.connection.readyState === 1;

/** Native driver handle for a tenant's isolated database, or null if offline. */
const getTenantDb = (dbName) => {
  if (!dbName || !isConnected()) return null;
  return mongoose.connection.useDb(dbName, { useCache: true }).db;
};

/* ------------------------------------------------------------------ */

const baselines = new WeakMap();

const fingerprint = (doc) => crypto.createHash('md5').update(JSON.stringify(doc)).digest('hex');

const stripId = (doc) => {
  if (doc && typeof doc === 'object' && '_id' in doc) delete doc._id;
  return doc;
};

function snapshot(store) {
  const map = {};
  for (const spec of ARRAY_COLLECTIONS) {
    const rows = Array.isArray(store[spec.key]) ? store[spec.key] : [];
    const entry = new Map();
    for (const row of rows) {
      const id = row?.[spec.idField];
      if (id === undefined || id === null) continue;
      entry.set(String(id), fingerprint(row));
    }
    map[spec.key] = entry;
  }
  for (const key of META_KEYS) {
    map[key] = fingerprint(store[key] ?? null);
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * Per-tenant serialization
 *
 * Hydrates and flushes for the same tenant run one after another, so a read
 * can never overtake a write that is still in flight.
 * ------------------------------------------------------------------ */

const queues = new Map();

function enqueue(dbName, task) {
  const previous = queues.get(dbName) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    dbName,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

/* ------------------------------------------------------------------ *
 * Hydrate
 * ------------------------------------------------------------------ */

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Merge stored settings over the defaults so new setting fields appear for existing tenants. */
function mergeSettings(base, stored) {
  if (!isPlainObject(stored)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? { ...base[key], ...value } : value;
  }
  return out;
}

/** Read the tenant's singleton values as one plain object. */
async function readMeta(db) {
  const metaDocs = await db.collection(META_COLLECTION).find({}).toArray();
  const meta = {};
  for (const doc of metaDocs) meta[doc._key] = doc.value;
  return meta;
}

async function doHydrate(dbName, store, tenant) {
  const db = getTenantDb(dbName);
  if (!db) {
    // Never fall back to the blank defaults: an empty catalogue served as if it
    // were the shop's data reads as "everything was deleted".
    throw new Error(`No MongoDB connection for tenant database "${dbName}".`);
  }

  let meta = await readMeta(db);

  // A database that has never been provisioned is built now, on first use, so
  // every later read has real rows to return.
  if (!meta[PROVISION_KEY]) {
    await doProvision(dbName, tenant);
    meta = await readMeta(db);
  }

  const loaded = await Promise.all(
    ARRAY_COLLECTIONS.map(async (spec) => {
      let cursor = db.collection(spec.collection).find({}, { projection: { _id: 0 } });
      if (spec.sort) cursor = cursor.sort(spec.sort);
      if (spec.limit) cursor = cursor.limit(spec.limit);
      return { spec, rows: await cursor.toArray() };
    })
  );

  // Every collection comes from the database, including the empty ones — what
  // the shop's database holds is the whole of the shop's state.
  for (const { spec, rows } of loaded) {
    store[spec.key] = rows.map(stripId);
  }

  if (meta.settings !== undefined) store.settings = mergeSettings(defaultSettings(), meta.settings);
  if (meta.session !== undefined) store.session = meta.session;
  if (meta.voucherCounters !== undefined) store.voucherCounters = meta.voucherCounters || {};
  if (Array.isArray(meta.units)) store.units = meta.units;
  if (Array.isArray(meta.customerGroups)) store.customerGroups = meta.customerGroups;

  await adoptLegacyData(db, store, meta);

  baselines.set(store, snapshot(store));
  return store;
}

/**
 * Pick up data written by the earlier persistence code so tenants provisioned
 * before this layer existed keep their settings and parties. Nothing is
 * deleted; the next flush simply rewrites it in the current layout.
 */
async function adoptLegacyData(db, store, meta) {
  try {
    if (meta.settings === undefined) {
      const legacy = await db.collection('settings').findOne({ key: 'company_settings' });
      if (legacy) {
        const { _id, key, createdAt, updatedAt, __v, ...sections } = legacy;
        store.settings = mergeSettings(defaultSettings(), sections);
      }
    }

    if (!store.customers?.length && !store.vendors?.length) {
      const parties = await db.collection('parties').find({}, { projection: { _id: 0 } }).toArray();
      if (parties.length) {
        store.customers = parties.filter((p) => p.type !== 'vendor').map(stripId);
        store.vendors = parties.filter((p) => p.type === 'vendor').map(stripId);
      }
    }
  } catch (err) {
    console.warn('[Tenant DB] legacy adoption skipped:', err.message);
  }
}

/**
 * Load a tenant's store from its own database.
 * Queued behind any flush already running for the same tenant.
 *
 * `tenant` is the master-database record, used only if the shop's database has
 * to be provisioned on the spot.
 */
const hydrateTenantStore = (dbName, store, tenant) => enqueue(dbName, () => doHydrate(dbName, store, tenant));

/* ------------------------------------------------------------------ *
 * Persist
 * ------------------------------------------------------------------ */

async function doPersist(dbName, store) {
  const db = getTenantDb(dbName);
  if (!db) return { persisted: false, reason: 'offline' };

  const before = baselines.get(store) || {};
  const after = snapshot(store);
  const written = {};

  const jobs = ARRAY_COLLECTIONS.map(async (spec) => {
    const prev = before[spec.key] instanceof Map ? before[spec.key] : new Map();
    const next = after[spec.key];
    const rows = Array.isArray(store[spec.key]) ? store[spec.key] : [];

    const operations = [];
    for (const row of rows) {
      const id = row?.[spec.idField];
      if (id === undefined || id === null) continue;
      const key = String(id);
      if (prev.get(key) === next.get(key)) continue;
      operations.push({
        replaceOne: {
          filter: { [spec.idField]: id },
          replacement: stripId({ ...row }),
          upsert: true
        }
      });
    }

    if (!spec.appendOnly) {
      const removed = [...prev.keys()].filter((id) => !next.has(id));
      if (removed.length) operations.push({ deleteMany: { filter: { [spec.idField]: { $in: removed } } } });
    }

    if (!operations.length) return;
    await db.collection(spec.collection).bulkWrite(operations, { ordered: false });
    written[spec.key] = operations.length;
  });

  const metaJobs = META_KEYS.map(async (key) => {
    if (before[key] === after[key]) return;
    await db
      .collection(META_COLLECTION)
      .updateOne({ _key: key }, { $set: { _key: key, value: store[key] ?? null, updatedAt: new Date() } }, { upsert: true });
    written[key] = 1;
  });

  await Promise.all([...jobs, ...metaJobs]);
  baselines.set(store, after);
  return { persisted: true, written };
}

/**
 * Write every change made to the store during this request back to the
 * tenant's own database. Queued per tenant.
 */
const persistTenantStore = (dbName, store) =>
  enqueue(dbName, () => doPersist(dbName, store)).catch((err) => {
    console.error(`[Tenant DB ${dbName}] persist failed:`, err.message);
    return { persisted: false, reason: err.message };
  });

/* ------------------------------------------------------------------ *
 * Provisioning
 * ------------------------------------------------------------------ */

/** Build the starting state for a brand-new shop: chart of accounts, counters, owner login. */
function seedStoreForTenant(tenant = {}) {
  const store = emptyStore();

  store.settings.company = {
    ...store.settings.company,
    name: tenant.name || store.settings.company.name,
    email: tenant.email || store.settings.company.email,
    phone: tenant.phone || store.settings.company.phone
  };

  if (tenant.name) {
    store.users = store.users.map((u) => (u.role === 'OWNER' ? { ...u, name: `${tenant.name} Owner` } : u));
  }

  return store;
}

/**
 * The provisioning work itself, WITHOUT the per-tenant queue.
 *
 * Kept separate because `doHydrate` provisions on first use from inside that
 * queue — going through `provisionTenantDB` there would make the queue wait on
 * a task it is already running.
 */
async function doProvision(dbName, tenant = {}) {
  const db = getTenantDb(dbName);
  if (!db) throw new Error(`Cannot provision "${dbName}" — no MongoDB connection.`);

  const marker = await db.collection(META_COLLECTION).findOne({ _key: PROVISION_KEY });
  if (marker) return { dbName, created: false };

  const store = seedStoreForTenant(tenant);
  baselines.set(store, {});
  await doPersist(dbName, store);

  await db.collection(META_COLLECTION).updateOne(
    { _key: PROVISION_KEY },
    {
      $set: {
        _key: PROVISION_KEY,
        value: { tenantId: tenant.tenantId || null, email: tenant.email || null, provisionedAt: new Date() }
      }
    },
    { upsert: true }
  );

  await Promise.all([
    db.collection('products').createIndex({ id: 1 }, { unique: true }).catch(() => {}),
    db.collection('products').createIndex({ barcode: 1 }).catch(() => {}),
    db.collection('categories').createIndex({ id: 1 }, { unique: true }).catch(() => {}),
    db.collection('sales').createIndex({ orderId: 1 }, { unique: true }).catch(() => {}),
    db.collection('sales').createIndex({ date: -1 }).catch(() => {}),
    db.collection('customers').createIndex({ id: 1 }, { unique: true }).catch(() => {}),
    db.collection('vendors').createIndex({ id: 1 }, { unique: true }).catch(() => {}),
    db.collection(META_COLLECTION).createIndex({ _key: 1 }, { unique: true }).catch(() => {})
  ]);

  console.log(`🗄️  [Tenant DB ${dbName}] provisioned and seeded for "${tenant.name || dbName}".`);
  return { dbName, created: true };
}

/**
 * Create and seed a tenant's isolated database.
 * Safe to call repeatedly — an already-provisioned database is left untouched.
 */
function provisionTenantDB(dbName, tenant = {}) {
  if (!dbName) return Promise.resolve(null);
  return enqueue(dbName, () => doProvision(dbName, tenant));
}

/** Diagnostics for the Super Admin database-health screen. */
async function getTenantDbStats(dbName) {
  const db = getTenantDb(dbName);
  if (!db) return null;
  try {
    const stats = await db.command({ dbStats: 1 });
    const counts = {};
    await Promise.all(
      ARRAY_COLLECTIONS.map(async (spec) => {
        counts[spec.key] = await db.collection(spec.collection).countDocuments();
      })
    );
    return {
      dbName,
      collections: stats.collections,
      sizeMB: Math.round(((stats.dataSize || 0) / (1024 * 1024)) * 100) / 100,
      counts
    };
  } catch {
    return null;
  }
}

module.exports = {
  ARRAY_COLLECTIONS,
  META_KEYS,
  getTenantDb,
  hydrateTenantStore,
  persistTenantStore,
  provisionTenantDB,
  seedStoreForTenant,
  getTenantDbStats
};
