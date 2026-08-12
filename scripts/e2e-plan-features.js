/**
 * Checks that a shop actually receives the modules its plan includes.
 *
 * Covers the two ways that used to fail:
 *   • the Tenant schema listed only six feature keys, so a wider map was
 *     silently truncated on save — an Enterprise shop came back with six;
 *   • `/features` read a pre-catalogue map literally while the route gate
 *     widened it, so tabs were hidden that the server would have allowed.
 *
 *   node scripts/e2e-plan-features.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('../server');
const config = require('../config/config');
const { getIsMongoConnected } = require('../db');
const { FEATURE_KEYS, CORE_FEATURES, PLAN_DEFAULTS, resolveTenantFeatures } = require('../modules/features');

const SHOP = { name: 'E2E Plan Features', email: 'e2e-plans@example.test' };

let server;
let base;
let pass = 0;
let fail = 0;

const ok = (label, condition, detail = '') => {
  condition ? (pass += 1) : (fail += 1);
  console.log(`  ${condition ? '✅' : '❌'} ${label}${condition || !detail ? '' : ` — ${detail}`}`);
};

const request = (method, path, { body, token } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
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

  const admin = adminToken();
  const TenantModel = require('../models/Tenant.model');

  console.log('\n[1] An Enterprise shop gets every module');

  const created = await request('POST', '/api/admin/tenants', { token: admin, body: { ...SHOP, plan: 'enterprise' } });
  const tenant = created.body.data;
  ok('Shop created on the enterprise plan', created.status === 201 && tenant.plan === 'enterprise');

  // The map must survive the round trip through Mongoose, not be trimmed to six keys.
  const stored = await TenantModel.findOne({ id: tenant.id }).lean();
  const storedKeys = Object.keys(stored.features || {});
  ok('Full feature map persisted, not truncated', storedKeys.length === FEATURE_KEYS.length,
    `stored ${storedKeys.length} of ${FEATURE_KEYS.length} keys`);

  const missingOff = FEATURE_KEYS.filter((k) => stored.features?.[k] !== true);
  ok('Every catalogue feature is enabled', missingOff.length === 0, `off: ${missingOff.join(', ')}`);

  const feat = await request('GET', '/api/pos/features', { token: tokenFor(tenant) });
  const enabled = feat.body?.data?.enabled || [];
  ok('/features reports every module', enabled.length === FEATURE_KEYS.length,
    `${enabled.length} of ${FEATURE_KEYS.length}: missing ${FEATURE_KEYS.filter((k) => !enabled.includes(k)).join(', ')}`);

  console.log('\n[2] Every module the client is shown is one the server allows');

  const gated = [
    ['/api/pos/warehouses', 'warehouses'],
    ['/api/pos/price-sheets', 'priceSheets'],
    ['/api/pos/vendors', 'vendors'],
    ['/api/pos/purchases', 'purchases'],
    ['/api/pos/accounts/chart', 'accounts'],
    ['/api/pos/reports/analytics', 'reports'],
    ['/api/pos/tables', 'tableMgmt'],
    ['/api/pos/recipes', 'compositeItems']
  ];

  for (const [path, key] of gated) {
    const res = await request('GET', path, { token: tokenFor(tenant) });
    const shownToClient = enabled.includes(key);
    const refusedAsNotInPlan = res.body?.code === 'FEATURE_NOT_IN_PLAN';
    ok(`${key}: tab shown and route open`, shownToClient && !refusedAsNotInPlan,
      `shown=${shownToClient} status=${res.status} code=${res.body?.code || '—'}`);
  }

  console.log('\n[3] Downgrading re-derives the plan, and core modules survive it');

  await request('PUT', `/api/admin/tenants/${tenant.id}`, { token: admin, body: { plan: 'starter' } });
  const afterDowngrade = await TenantModel.findOne({ id: tenant.id }).lean();
  const starterMap = resolveTenantFeatures(afterDowngrade);

  ok('Plan recorded as starter', afterDowngrade.plan === 'starter');
  ok('Core modules still on', CORE_FEATURES.every((k) => starterMap[k] === true),
    CORE_FEATURES.filter((k) => !starterMap[k]).join(', '));

  // The authority is the stored plan document — that is what the Super Admin's
  // plan editor writes. PLAN_DEFAULTS only fills in for a plan with no list.
  const PlanModel = require('../models/Plan.model');
  const starterPlan = await PlanModel.findOne({ id: 'starter' }).lean();
  const planGrants = starterPlan?.features?.length ? starterPlan.features : PLAN_DEFAULTS.starter;

  const addOns = FEATURE_KEYS.filter((k) => !CORE_FEATURES.includes(k));
  const grantedAddOns = addOns.filter((k) => starterMap[k]);
  const expected = addOns.filter((k) => planGrants.includes(k));
  ok('Tier add-ons match the stored starter plan', grantedAddOns.join() === expected.join(),
    `granted [${grantedAddOns.join(', ')}] expected [${expected.join(', ')}]`);

  console.log('\n[4] A shop still carrying the old six-key map is widened, not read literally');

  await TenantModel.updateOne(
    { id: tenant.id },
    { $set: { plan: 'enterprise', features: { billing: true, inventory: true, purchases: true, reports: true, compositeItems: true, tableMgmt: true } } }
  );
  const legacy = await TenantModel.findOne({ id: tenant.id }).lean();
  const widened = resolveTenantFeatures(legacy);

  ok('Legacy map widened to the tier', FEATURE_KEYS.every((k) => widened[k] === true),
    `still off: ${FEATURE_KEYS.filter((k) => !widened[k]).join(', ')}`);

  // No cache to refresh — the request below re-reads the shop from the master
  // database, so the legacy map written above is what the gate sees.
  const legacyFeat = await request('GET', '/api/pos/features', { token: tokenFor(legacy) });
  const legacyEnabled = legacyFeat.body?.data?.enabled || [];
  ok('/features agrees with the route gate', legacyEnabled.length === FEATURE_KEYS.length,
    `${legacyEnabled.length} of ${FEATURE_KEYS.length}`);

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
