/**
 * Guards the rule that decides when the POS client signs a user out.
 *
 * Opening a tab whose feature the plan excludes, or mistyping a counter PIN,
 * must NOT end the session. Only a real authentication failure may.
 *
 *   node scripts/e2e-session-codes.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../server');
const config = require('../config/config');
const { getIsMongoConnected } = require('../db');
const { SESSION_ENDED_CODES } = require('../middlewares/tenant.middleware');

const SHOP = { name: 'E2E Session Codes', email: 'e2e-session@example.test' };

let server;
let base;
let pass = 0;
let fail = 0;

const ok = (label, condition, detail = '') => {
  condition ? (pass += 1) : (fail += 1);
  console.log(`  ${condition ? '✅' : '❌'} ${label}${condition || !detail ? '' : ` — ${detail}`}`);
};

/** The rule the POS client applies, kept identical to src/lib/api.js. */
const clientWouldSignOut = ({ status, body }) => {
  const code = body?.code;
  if (code) return SESSION_ENDED_CODES.includes(code);
  return status === 401;
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
          let parsed;
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

const tokenFor = (t) =>
  jwt.sign(
    { tenantId: t.tenantId, name: t.name, email: t.email, dbName: t.dbName, slug: t.slug, plan: t.plan, role: 'Owner' },
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

async function cleanup() {
  const TenantModel = require('../models/Tenant.model');
  const existing = await TenantModel.findOne({ email: SHOP.email }).lean();
  if (existing?.dbName) {
    await mongoose.connection.useDb(existing.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  }
  await TenantModel.deleteOne({ email: SHOP.email });
}

(async () => {
  const started = Date.now();
  while (!getIsMongoConnected() && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 250));
  await cleanup();

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // A starter shop — the lowest tier, so every core module must still open.
  const created = await request('POST', '/api/admin/tenants', {
    token: adminToken(),
    body: { ...SHOP, plan: 'starter' }
  });
  const tenant = created.body.data;
  const token = tokenFor(tenant);
  console.log(`\nShop on the "${tenant.plan}" plan — ${tenant.dbName}`);

  console.log('\n[1] Opening the Stock screen must not sign the user out');

  // Multi-warehouse stock is a core module in the feature catalogue, so the
  // Stock screen opens on every tier. Whichever way it answers, the one thing
  // it must never do is end the session.
  const warehouses = await request('GET', '/api/pos/warehouses', { token });
  ok('Stock screen opens on the lowest tier', warehouses.status === 200, `status ${warehouses.status}`);
  ok('...and the client stays signed in', clientWouldSignOut(warehouses) === false);

  for (const path of ['/api/pos/units', '/api/pos/inventory/summary', '/api/pos/products', '/api/pos/categories']) {
    const res = await request('GET', path, { token });
    ok(`${path} works`, res.status === 200, `status ${res.status}`);
    ok(`...and does not sign out`, clientWouldSignOut(res) === false);
  }

  const sheets = await request('GET', '/api/pos/price-sheets', { token });
  ok('Price sheets refusal does not sign out', clientWouldSignOut(sheets) === false, `status ${sheets.status}`);

  console.log('\n[2] Other refusals must not sign the user out either');

  const badPin = await request('POST', '/api/pos/users/verify-pin', { token, body: { userId: 'u_owner', pin: '9999' } });
  ok('Wrong counter PIN is rejected', badPin.status === 401, `status ${badPin.status}`);
  ok('...and does not sign out', clientWouldSignOut(badPin) === false, `code ${badPin.body?.code}`);

  console.log('\n[3] Real authentication failures still sign the user out');

  const noToken = await request('GET', '/api/pos/products');
  ok('Missing token signs out', noToken.status === 401 && clientWouldSignOut(noToken) === true);

  const badToken = await request('GET', '/api/pos/products', { token: 'not-a-real-token' });
  ok('Invalid token signs out', badToken.status === 401 && clientWouldSignOut(badToken) === true);

  const expired = jwt.sign({ dbName: tenant.dbName, tenantId: tenant.tenantId }, config.JWT_SECRET, { expiresIn: '-1s' });
  const expiredRes = await request('GET', '/api/pos/products', { token: expired });
  ok('Expired token signs out', clientWouldSignOut(expiredRes) === true, `status ${expiredRes.status}`);

  const spoof = await request('GET', '/api/pos/products', { token, headers: { 'x-tenant-db': 'tenant_db_isekai' } });
  ok('Cross-shop attempt signs out', spoof.status === 403 && clientWouldSignOut(spoof) === true, `code ${spoof.body?.code}`);

  await request('PATCH', `/api/admin/tenants/${tenant.id}/status`, { token: adminToken(), body: { status: 'inactive' } });
  const deactivated = await request('GET', '/api/pos/products', { token });
  ok('Deactivated shop signs out', deactivated.status === 403 && clientWouldSignOut(deactivated) === true,
    `code ${deactivated.body?.code}`);

  console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);

  await cleanup();
  server.close();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('\nRun failed:', err);
  try {
    await cleanup();
    server?.close();
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
