/**
 * End-to-end check of the purchase-returns flow, specifically the two bugs fixed alongside this
 * test: (1) voiding a serial-tracked vendor credit silently failed to restore the actual serial
 * record to IN_STOCK even though it bumped the stock count, and (2) plain-stock returns/voids always
 * touched the default warehouse regardless of which warehouse the purchase actually received into.
 *
 * Run: node scripts/e2e-purchase-returns.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../server');
const config = require('../config/config');
const { getIsMongoConnected } = require('../db');

const SHOP = { name: 'E2E Purchase Returns', email: 'e2e-purchase-returns@example.test' };

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

const tokenFor = (tenant) =>
  jwt.sign(
    { tenantId: tenant.tenantId, name: tenant.name, email: tenant.email, dbName: tenant.dbName, slug: tenant.slug, plan: tenant.plan, role: 'Owner' },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

const adminToken = () =>
  jwt.sign(
    { sub: 'sa_001', email: (process.env.SUPER_ADMIN_EMAIL || 'zunasoftdevelopment@gmail.com').toLowerCase(), name: 'Zunasoft Super Admin', role: 'SuperAdmin', scope: 'admin-console' },
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
  const existing = await TenantModel.findOne({ email: SHOP.email }).lean();
  if (existing?.dbName) {
    await mongoose.connection.useDb(existing.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  }
  await TenantModel.deleteOne({ email: SHOP.email });
}

(async () => {
  await waitForMongo();
  await cleanup();

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = adminToken();
  const created = await request('POST', '/api/admin/tenants', { token: admin, body: { ...SHOP, plan: 'pro' } });
  if (created.status !== 201) {
    console.error('Could not provision test tenant:', JSON.stringify(created.body));
    process.exit(1);
  }
  const tenant = created.body.data;
  const token = tokenFor(tenant);
  const h = { token, headers: { 'x-tenant-db': tenant.dbName } };

  console.log('\n[1] Serial-tracked purchase + return + void-of-return restores the actual serial');

  const vendorRes = await request('POST', '/api/pos/vendors', { ...h, body: { name: 'E2E Vendor', phone: '', email: '' } });
  ok('Vendor created', vendorRes.status === 201 || vendorRes.status === 200, JSON.stringify(vendorRes.body));
  const vendorId = vendorRes.body.data.id;

  const productRes = await request('POST', '/api/pos/products', {
    ...h,
    body: { name: 'E2E Serial Phone', unit: 'pcs', price: 500, purchasePrice: 300, trackSerials: true, stock: 0 }
  });
  ok('Serial-tracked product created', productRes.status === 201, JSON.stringify(productRes.body));
  const productId = productRes.body.data.id;

  const purchaseRes = await request('POST', '/api/pos/purchases', {
    ...h,
    body: {
      vendorId,
      invoiceNo: 'E2E-INV-1',
      items: [{ productId, qty: 2, unit: 'pcs', rate: 300, serials: [{ serialNo: 'SN001' }, { serialNo: 'SN002' }] }]
    }
  });
  ok('Purchase of 2 serial units created', purchaseRes.status === 201, JSON.stringify(purchaseRes.body));
  const purchaseId = purchaseRes.body.data.id;

  let productAfterPurchase = (await request('GET', `/api/pos/products`, h)).body.data.find((p) => p.id === productId);
  ok('Stock is 2 after receiving both serial units', Number(productAfterPurchase.stock) === 2, productAfterPurchase.stock);
  const serialToReturn = productAfterPurchase.serials.find((s) => s.serialNo === 'SN001');

  const returnRes = await request('POST', `/api/pos/purchases/${purchaseId}/return`, {
    ...h,
    body: { items: [{ productId, serialIds: [serialToReturn.id] }], reason: 'E2E test return' }
  });
  ok('Return of 1 serial unit accepted', returnRes.status === 201, JSON.stringify(returnRes.body));
  const vendorCreditId = returnRes.body.data.id;

  let productAfterReturn = (await request('GET', `/api/pos/products`, h)).body.data.find((p) => p.id === productId);
  const returnedSerial = productAfterReturn.serials.find((s) => s.id === serialToReturn.id);
  ok('Stock drops to 1 after the return', Number(productAfterReturn.stock) === 1, productAfterReturn.stock);
  ok('The specific serial is marked RETURNED', returnedSerial.status === 'RETURNED', returnedSerial.status);

  const voidCreditRes = await request('POST', `/api/pos/vendor-credits/${vendorCreditId}/void`, h);
  ok('Voiding the vendor credit succeeds', voidCreditRes.status === 200, JSON.stringify(voidCreditRes.body));

  let productAfterVoid = (await request('GET', `/api/pos/products`, h)).body.data.find((p) => p.id === productId);
  const restoredSerial = productAfterVoid.serials.find((s) => s.id === serialToReturn.id);
  ok('Stock is back to 2 after voiding the return', Number(productAfterVoid.stock) === 2, productAfterVoid.stock);
  ok('THE FIX: the actual serial is restored to IN_STOCK (not just the count)', restoredSerial.status === 'IN_STOCK', restoredSerial.status);

  console.log('\n[2] Plain-stock return respects the receiving warehouse, not always the default');

  const warehousesRes = await request('GET', '/api/pos/warehouses', h);
  const defaultWh = warehousesRes.body.data.find((w) => w.isDefault);
  const otherWh = warehousesRes.body.data.find((w) => !w.isDefault) || (await request('POST', '/api/pos/warehouses', { ...h, body: { name: 'Godown 2' } })).body.data;

  const plainProductRes = await request('POST', '/api/pos/products', {
    ...h,
    body: { name: 'E2E Plain Widget', unit: 'pcs', price: 50, purchasePrice: 30, stock: 0 }
  });
  const plainProductId = plainProductRes.body.data.id;

  const plainPurchaseRes = await request('POST', '/api/pos/purchases', {
    ...h,
    body: { vendorId, invoiceNo: 'E2E-INV-2', items: [{ productId: plainProductId, qty: 10, unit: 'pcs', rate: 30, warehouseId: otherWh.id }] }
  });
  const plainPurchaseId = plainPurchaseRes.body.data.id;
  const receivedLine = plainPurchaseRes.body.data.items[0];
  ok('Purchase line records the non-default warehouse it was received into', receivedLine.warehouseId === otherWh.id, receivedLine.warehouseId);

  let plainAfterPurchase = (await request('GET', '/api/pos/products', h)).body.data.find((p) => p.id === plainProductId);
  ok(`Stock landed in ${otherWh.name}, not the default`, Number(plainAfterPurchase.warehouses?.[otherWh.id]) === 10, JSON.stringify(plainAfterPurchase.warehouses));
  ok(`Default warehouse (${defaultWh.name}) untouched`, Number(plainAfterPurchase.warehouses?.[defaultWh.id] || 0) === 0);

  const plainReturnRes = await request('POST', `/api/pos/purchases/${plainPurchaseId}/return`, {
    ...h,
    body: { items: [{ productId: plainProductId, qty: 4 }], reason: 'E2E test return' }
  });
  ok('Plain-stock return accepted', plainReturnRes.status === 201, JSON.stringify(plainReturnRes.body));
  const plainCreditId = plainReturnRes.body.data.id;

  let plainAfterReturn = (await request('GET', '/api/pos/products', h)).body.data.find((p) => p.id === plainProductId);
  ok('THE FIX: return deducted from the receiving warehouse, not the default', Number(plainAfterReturn.warehouses?.[otherWh.id]) === 6, JSON.stringify(plainAfterReturn.warehouses));
  ok('Default warehouse still untouched by the return', Number(plainAfterReturn.warehouses?.[defaultWh.id] || 0) === 0);

  const voidPlainCreditRes = await request('POST', `/api/pos/vendor-credits/${plainCreditId}/void`, h);
  ok('Voiding the plain-stock return succeeds', voidPlainCreditRes.status === 200, JSON.stringify(voidPlainCreditRes.body));

  let plainAfterVoid = (await request('GET', '/api/pos/products', h)).body.data.find((p) => p.id === plainProductId);
  ok('THE FIX: void restores into the same warehouse it was taken from', Number(plainAfterVoid.warehouses?.[otherWh.id]) === 10, JSON.stringify(plainAfterVoid.warehouses));

  console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);

  await new Promise((r) => server.close(r));
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('Test run failed:', err);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
