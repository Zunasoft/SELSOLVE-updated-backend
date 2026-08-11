/**
 * Compatibility layer over `tenantDb`.
 *
 * Tenant persistence now runs through the request lifecycle: the middleware
 * hydrates `req.tenantStore` from the tenant's own database and flushes it back
 * before responding, so route handlers no longer need to save records by hand.
 *
 * The per-record helpers below are kept because existing routes call them, and
 * because they are useful outside a request (scripts, migrations). They write
 * straight to the calling tenant's database and never to the master database.
 */

const tenantDb = require('./tenantDb');
const { getTenantStore } = require('./store');

const {
  getTenantDb,
  hydrateTenantStore,
  persistTenantStore,
  provisionTenantDB,
  getTenantDbStats
} = tenantDb;

/** Upsert one record into a collection of the tenant's own database. */
async function upsert(dbName, collection, idField, record, label) {
  const db = getTenantDb(dbName);
  if (!db || !record || record[idField] === undefined) return null;
  try {
    const { _id, ...clean } = record;
    await db.collection(collection).replaceOne({ [idField]: record[idField] }, clean, { upsert: true });
    return record;
  } catch (err) {
    console.error(`⚠️ [Tenant DB ${dbName}] save ${label} failed:`, err.message);
    return null;
  }
}

async function remove(dbName, collection, idField, id, label) {
  const db = getTenantDb(dbName);
  if (!db || id === undefined) return;
  try {
    await db.collection(collection).deleteOne({ [idField]: id });
  } catch (err) {
    console.error(`⚠️ [Tenant DB ${dbName}] delete ${label} failed:`, err.message);
  }
}

const saveProductToDb = (dbName, product) => upsert(dbName, 'products', 'id', product, 'product');
const deleteProductFromDb = (dbName, id) => remove(dbName, 'products', 'id', id, 'product');

const saveCategoryToDb = (dbName, category) => upsert(dbName, 'categories', 'id', category, 'category');
const deleteCategoryFromDb = (dbName, id) => remove(dbName, 'categories', 'id', id, 'category');

const saveWarehouseToDb = (dbName, warehouse) => upsert(dbName, 'warehouses', 'id', warehouse, 'warehouse');

/** Parties are stored in two collections so customer and vendor ledgers stay separate. */
const savePartyToDb = (dbName, party) => {
  const collection = party?.type === 'vendor' ? 'vendors' : 'customers';
  const { type, ...record } = party || {};
  return upsert(dbName, collection, 'id', record, collection);
};

const deletePartyFromDb = async (dbName, id) => {
  await remove(dbName, 'customers', 'id', id, 'customer');
  await remove(dbName, 'vendors', 'id', id, 'vendor');
};

/** A completed bill. Orders are keyed by `orderId`, which is the invoice number. */
const saveSaleToDb = (dbName, order) => upsert(dbName, 'sales', 'orderId', order, 'sale');

/** Store settings live as a single document in the tenant's `meta` collection. */
const saveSettingsToDb = async (dbName, settings) => {
  const db = getTenantDb(dbName);
  if (!db) return;
  try {
    await db
      .collection('meta')
      .updateOne({ _key: 'settings' }, { $set: { _key: 'settings', value: settings, updatedAt: new Date() } }, { upsert: true });
  } catch (err) {
    console.error(`⚠️ [Tenant DB ${dbName}] save settings failed:`, err.message);
  }
};

/**
 * Retained for callers that still ask for a tenant's store to be refreshed
 * from its database.
 */
const syncTenantFromDb = (dbName, store) => hydrateTenantStore(dbName, store || getTenantStore(dbName));

module.exports = {
  provisionTenantDB,
  syncTenantFromDb,
  hydrateTenantStore,
  persistTenantStore,
  getTenantDb,
  getTenantDbStats,
  saveProductToDb,
  deleteProductFromDb,
  saveCategoryToDb,
  deleteCategoryFromDb,
  savePartyToDb,
  deletePartyFromDb,
  saveSaleToDb,
  saveWarehouseToDb,
  saveSettingsToDb
};
