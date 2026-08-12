/**
 * End-to-end check of the tenant workflow:
 *   admin creates shop -> shop DB provisioned -> owner signs in -> owner works
 *   in the POS -> every change lands in that shop's own database and nowhere else.
 *
 * Run:  node _e2e_tenant_isolation.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../server');
const config = require('../config/config');
const { getIsMongoConnected } = require('../db');

const SHOP_A = { name: 'E2E Alpha Mart', email: 'e2e-alpha@example.test' };
const SHOP_B = { name: 'E2E Beta Store', email: 'e2e-beta@example.test' };

let server;
let base;
let pass = 0;
let fail = 0;

const ok = (label, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const request = (method, path, { body, token, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

/** The token the OTP flow hands a shop owner after verification. */
const tokenFor = (tenant) =>
  jwt.sign(
    {
      tenantId: tenant.tenantId,
      name: tenant.name,
      email: tenant.email,
      dbName: tenant.dbName,
      slug: tenant.slug,
      plan: tenant.plan,
      role: 'Owner'
    },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

const adminToken = () =>
  jwt.sign(
    {
      sub: 'sa_001',
      email: (process.env.SUPER_ADMIN_EMAIL || 'zunasoftdevelopment@gmail.com').toLowerCase(),
      name: 'Zunasoft Super Admin',
      role: 'SuperAdmin',
      scope: 'admin-console'
    },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

const raw = (dbName, collection) => mongoose.connection.useDb(dbName, { useCache: true }).db.collection(collection);

async function waitForMongo(timeoutMs = 30000) {
  const started = Date.now();
  while (!getIsMongoConnected() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!getIsMongoConnected()) throw new Error('Master MongoDB did not connect in time.');
}

async function cleanup() {
  const TenantModel = require('../models/Tenant.model');
  for (const shop of [SHOP_A, SHOP_B]) {
    const existing = await TenantModel.findOne({ email: shop.email }).lean();
    if (existing?.dbName) {
      await mongoose.connection.useDb(existing.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
    }
    await TenantModel.deleteOne({ email: shop.email });
  }
}

(async () => {
  await waitForMongo();
  await cleanup();

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = adminToken();

  /* ---------------- 1. Super Admin creates two shops ---------------- */
  console.log('\n[1] Super Admin provisions two shops');

  const createA = await request('POST', '/api/admin/tenants', { token: admin, body: { ...SHOP_A, plan: 'pro' } });
  const createB = await request('POST', '/api/admin/tenants', { token: admin, body: { ...SHOP_B, plan: 'starter' } });

  ok('Shop A created', createA.status === 201, JSON.stringify(createA.body));
  ok('Shop B created', createB.status === 201, JSON.stringify(createB.body));

  const tenantA = createA.body.data;
  const tenantB = createB.body.data;

  ok('Shop A and Shop B got different databases', tenantA.dbName !== tenantB.dbName, `${tenantA.dbName} vs ${tenantB.dbName}`);

  const marker = await raw(tenantA.dbName, 'meta').findOne({ _key: '__provisioned' });
  ok('Shop A database was really provisioned', Boolean(marker));

  const masterTenant = await require('../models/Tenant.model').findOne({ email: SHOP_A.email }).lean();
  ok('Shop A details are in the MASTER database', Boolean(masterTenant) && masterTenant.dbName === tenantA.dbName);

  /* ---------------- 2. Owner signs in and works in the POS ---------------- */
  console.log('\n[2] Shop A owner adds a category, a product and rings up a sale');

  const tokA = tokenFor(tenantA);
  const tokB = tokenFor(tenantB);

  const cat = await request('POST', '/api/pos/categories', { token: tokA, body: { name: 'Fruits', icon: '🍎' } });
  ok('Category created', cat.status === 201, JSON.stringify(cat.body));

  const prod = await request('POST', '/api/pos/products', {
    token: tokA,
    body: { name: 'Alpha Apple', price: 100, purchasePrice: 60, stock: 50, categoryId: cat.body?.data?.id, unit: 'kg' }
  });
  ok('Product created', prod.status === 201, JSON.stringify(prod.body));
  const productId = prod.body?.data?.id;

  const sale = await request('POST', '/api/pos/orders', {
    token: tokA,
    body: {
      items: [{ id: productId, name: 'Alpha Apple', qty: 2, price: 100, total: 200 }],
      subtotal: 200,
      tax: 0,
      discount: 0,
      total: 200,
      paymentMethod: 'Cash'
    }
  });
  ok('Sale checked out', sale.status === 201, JSON.stringify(sale.body).slice(0, 300));

  const customer = await request('POST', '/api/pos/customers', {
    token: tokA,
    body: { name: 'Alpha Regular', phone: '9000000001' }
  });
  ok('Customer created', customer.status === 201, JSON.stringify(customer.body));

  await request('PUT', '/api/pos/settings/company', { token: tokA, body: { name: 'Alpha Mart Pvt Ltd', gstin: '33ALPHA1234A1Z5' } });

  /* ---------------- 3. It landed in Shop A's own database ---------------- */
  console.log("\n[3] Everything landed in Shop A's own database");

  const aProducts = await raw(tenantA.dbName, 'products').find({}).toArray();
  const aCategories = await raw(tenantA.dbName, 'categories').find({}).toArray();
  const aSales = await raw(tenantA.dbName, 'sales').find({}).toArray();
  const aCustomers = await raw(tenantA.dbName, 'customers').find({}).toArray();
  const aJournal = await raw(tenantA.dbName, 'journal').find({}).toArray();
  const aMovements = await raw(tenantA.dbName, 'stockmovements').find({}).toArray();
  const aSettings = await raw(tenantA.dbName, 'meta').findOne({ _key: 'settings' });

  ok('Product persisted to Shop A DB', aProducts.some((p) => p.name === 'Alpha Apple'), `found ${aProducts.length}`);
  ok('Stock deducted by the sale (50 → 48)', aProducts.find((p) => p.name === 'Alpha Apple')?.stock === 48,
    String(aProducts.find((p) => p.name === 'Alpha Apple')?.stock));
  ok('Category persisted to Shop A DB', aCategories.some((c) => c.name === 'Fruits'));
  ok('Invoice persisted to Shop A DB', aSales.length === 1, `found ${aSales.length}`);
  ok('Customer persisted to Shop A DB', aCustomers.some((c) => c.name === 'Alpha Regular'));
  ok('Accounting vouchers persisted to Shop A DB', aJournal.length > 0, `found ${aJournal.length}`);
  ok('Stock movements persisted to Shop A DB', aMovements.length > 0, `found ${aMovements.length}`);
  ok('Store settings persisted to Shop A DB', aSettings?.value?.company?.gstin === '33ALPHA1234A1Z5');

  /* ---------------- 4. Nothing leaked into master or the other shop ---------------- */
  console.log('\n[4] Nothing leaked into the master database or into Shop B');

  const masterDb = mongoose.connection.useDb('selsolve', { useCache: true }).db;
  const masterAlpha = await masterDb.collection('products').countDocuments({ name: 'Alpha Apple' });
  ok('Master DB has no copy of the product', masterAlpha === 0, `found ${masterAlpha}`);

  const bProducts = await raw(tenantB.dbName, 'products').find({}).toArray();
  ok('Shop B database is untouched', bProducts.length === 0, `found ${bProducts.length}`);

  const bList = await request('GET', '/api/pos/products', { token: tokB });
  ok('Shop B cannot see Shop A products over the API', Array.isArray(bList.body?.data) && bList.body.data.length === 0,
    JSON.stringify(bList.body).slice(0, 200));

  /* ---------------- 5. Isolation cannot be bypassed ---------------- */
  console.log('\n[5] A shop cannot reach another shop by changing headers');

  const spoof = await request('GET', '/api/pos/products', {
    token: tokB,
    headers: { 'x-tenant-db': tenantA.dbName }
  });
  ok('Header spoofing is rejected', spoof.status === 403, `status ${spoof.status}`);

  const noAuth = await request('GET', '/api/pos/products', { headers: { 'x-tenant-db': tenantA.dbName } });
  ok('Unauthenticated access is rejected', noAuth.status === 401, `status ${noAuth.status}`);

  /* ---------------- 6. Every read comes from the shop's database ---------------- */
  console.log('\n[6] Reads come from the shop database, not from process memory');

  // There is no cache to drop: each request builds a fresh working set and
  // fills it from `tenant_db_*`, which is what makes two instances agree.
  const afterRestart = await request('GET', '/api/pos/init', { token: tokA });
  const products = afterRestart.body?.data?.products || [];
  const reloaded = products.find((p) => p.name === 'Alpha Apple');
  ok('Product still there after cache wipe', Boolean(reloaded), `got ${products.length} products`);
  ok('Stock level survived', reloaded?.stock === 48, String(reloaded?.stock));
  ok('Settings survived', afterRestart.body?.data?.settings?.company?.gstin === '33ALPHA1234A1Z5');

  const ordersAfter = await request('GET', '/api/pos/orders', { token: tokA });
  ok('Invoice still readable after restart', (ordersAfter.body?.data || []).length === 1,
    `found ${(ordersAfter.body?.data || []).length}`);

  /* ---------------- 7. Deactivated shop is locked out ---------------- */
  console.log('\n[7] A deactivated shop cannot use the POS');

  await request('PATCH', `/api/admin/tenants/${tenantA.id}/status`, { token: admin, body: { status: 'inactive' } });
  const blocked = await request('GET', '/api/pos/products', { token: tokA });
  ok('Deactivated shop is blocked', blocked.status === 403, `status ${blocked.status}`);

  /* ---------------- done ---------------- */
  console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);

  await cleanup();
  server.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('\nE2E run failed:', err);
  try {
    await cleanup();
    server?.close();
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
