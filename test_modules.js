/**
 * End-to-end check of the SOW modules against the real Express app.
 *
 * Runs against the real databases, because the application has no other mode:
 * the master database holds the shop record and an isolated `tenant_db_*`
 * database holds its data. A test shop is written to the master database and a
 * session token signed for it, so every request goes through the genuine auth,
 * tenant-isolation and plan-feature middleware rather than around them. The
 * shop and its database are removed again when the run finishes.
 *
 *   node test_modules.js          (needs ADMIN_BE_URL / MONGODB_URI set)
 */

process.env.NODE_ENV = 'test';

const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('./server.js');
const { models, ensureMasterDB } = require('./db');
const config = require('./config/config');
const { featuresForPlan } = require('./modules/features');

const PORT = 5199;

/* ------------------------------------------------------------------ *
 * Test tenant — on the top tier so every feature gate is open.
 * ------------------------------------------------------------------ */

const TENANT = {
  id: 't_test',
  tenantId: 'testshop',
  name: 'Test Shop',
  slug: 'testshop',
  email: 'owner@testshop.com',
  phone: '+91 9000000000',
  dbName: 'tenant_db_testshop',
  status: 'active',
  plan: 'enterprise',
  expiryDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
  maxDevices: 25,
  createdAt: new Date().toISOString()
};
/** Plans, read once from the master database at setup. */
let PLANS = [];
const planById = (id) => PLANS.find((p) => p.id === id) || null;

/** Put the test shop in the master database and give it a clean tenant database. */
async function setup() {
  if (!(await ensureMasterDB())) {
    throw new Error('MongoDB is unreachable — set ADMIN_BE_URL (or MONGODB_URI) before running the suite.');
  }

  PLANS = await models.Plan.find().lean();
  TENANT.features = featuresForPlan(planById('enterprise'), 'enterprise');

  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  await models.Tenant.findOneAndUpdate({ id: TENANT.id }, TENANT, { upsert: true });
}

/** The feature map is stored on the shop, so a mid-run change has to be written. */
const setTenantFeatures = (features) => models.Tenant.updateOne({ id: TENANT.id }, { $set: { features } });

async function teardown() {
  await models.Tenant.deleteOne({ id: TENANT.id });
  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
}

const TOKEN = jwt.sign(
  {
    tenantId: TENANT.tenantId,
    name: TENANT.name,
    email: TENANT.email,
    dbName: TENANT.dbName,
    slug: TENANT.slug,
    plan: TENANT.plan,
    role: 'Owner'
  },
  config.JWT_SECRET,
  { expiresIn: '1h' }
);

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function request(method, path, body = null, { token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: encodeURI(`/api/pos${path}`),
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-user-name': 'Owner',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (name) => console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

async function run() {
  section('Auth & tenant isolation');

  const noToken = await request('GET', '/init', null, { token: null });
  check('Unauthenticated request is refused', noToken.status === 401, `status ${noToken.status}`);

  const otherToken = jwt.sign({ ...jwt.decode(TOKEN), dbName: 'tenant_db_someoneelse' }, config.JWT_SECRET);
  const crossTenant = await request('GET', '/init', null, { token: otherToken });
  check('Token for an unknown shop is refused', crossTenant.status === 404 || crossTenant.status === 401, `status ${crossTenant.status}`);

  const init = await request('GET', '/init');
  check('Terminal boots', init.body.success === true);

  section('Module 1 — plan features');

  const features = await request('GET', '/features');
  check('Feature map is exposed', features.body.success && features.body.data.features.billing === true);
  check('Enterprise unlocks composite items', features.body.data.features.compositeItems === true);

  /* ----------------------------------------------------------------
   * Regression: the standard POS modules are core and must survive any
   * tier. An earlier build made accounts/purchases/vendors tier-sold, which
   * hid the Accounts tab from every starter and trial shop and answered 403
   * on its API. Both the map and the routes are pinned here.
   * ---------------------------------------------------------------- */
  const CORE_MODULES = ['dashboard', 'billing', 'products', 'inventory', 'customers',
    'purchases', 'vendors', 'accounts', 'expenses', 'reports', 'exports', 'cashFlow'];

  for (const plan of ['trial', 'starter', 'monthly', 'pro', 'yearly', 'enterprise', 'no-such-plan']) {
    const map = featuresForPlan(planById(plan), plan);
    const missing = CORE_MODULES.filter((k) => !map[k]);
    check(`Plan "${plan}" keeps every core module`, missing.length === 0, missing.length ? `hidden: ${missing.join(', ')}` : 'all present');
  }

  // Downgrade the shop mid-flight and confirm the gate bites only on add-ons.
  await setTenantFeatures(featuresForPlan({ features: ['billing', 'products', 'inventory', 'reports'] }, 'starter'));

  const blocked = await request('GET', '/tables');
  check('A tier-sold add-on outside the plan is blocked', blocked.status === 403, `status ${blocked.status}`);
  check('Block explains itself', blocked.body.code === 'FEATURE_NOT_IN_PLAN');

  for (const [label, path] of [
    ['Accounts', '/accounts/dashboard'],
    ['Chart of accounts', '/accounts/chart'],
    ['Expenses', '/accounts/expenses'],
    ['Purchases', '/purchases'],
    ['Vendors', '/vendors'],
    ['Reports', '/reports/stock'],
    ['Warehouses', '/warehouses'],
    ['Price sheets', '/price-sheets'],
    ['Products', '/products']
  ]) {
    const res = await request('GET', path);
    check(`${label} stays reachable on the lowest tier`, res.status === 200, `status ${res.status}`);
  }

  await setTenantFeatures(featuresForPlan(planById('enterprise'), 'enterprise'));

  section('Module 4 — products, barcodes, multiple units');

  const cat = await request('POST', '/categories', { name: 'Bakery', icon: '🥐' });
  check('Category created', cat.body.success === true);
  const categoryId = cat.body.data.id;

  const flour = await request('POST', '/products', {
    name: 'Wheat Flour', categoryId, unit: 'kg', price: 60, purchasePrice: 40, stock: 100, barcode: '8900000001'
  });
  check('Raw material created', flour.body.success === true);

  const butter = await request('POST', '/products', {
    name: 'Butter', categoryId, unit: 'g', price: 2, purchasePrice: 1, stock: 5000, barcode: '8900000002'
  });
  check('Second raw material created', butter.body.success === true);

  const multi = await request('POST', '/products', {
    name: 'Cola Bottle',
    categoryId,
    unit: 'pcs',
    price: 20,
    purchasePrice: 14,
    stock: 240,
    barcode: '8900000003',
    barcodes: ['8900000003', '8900000009'],
    regionalName: 'கோலா',
    altUnits: [
      { unit: 'box', factor: 24, price: 460, barcode: '8900000004' },
      { unit: 'pcs', factor: 1 } // duplicate of the base unit — must be dropped
    ]
  });
  check('Multiple units accepted', multi.body.data.altUnits.length === 1, `${multi.body.data.altUnits.length} alt unit(s)`);
  check('Base unit cannot be re-added as an alternate', !multi.body.data.altUnits.some((u) => u.unit === 'pcs'));
  check('Multiple barcodes stored', multi.body.data.barcodes.length === 2);
  check('Regional print name stored', multi.body.data.regionalName === 'கோலா');

  const byAltBarcode = await request('GET', '/products/lookup/8900000009');
  check('Secondary barcode resolves', byAltBarcode.body.success === true);

  section('Module 18 — composite items on the product form');

  const noRecipe = await request('POST', '/products', {
    name: 'Broken Cake', categoryId, unit: 'pcs', price: 300, productType: 'composite'
  });
  check('Composite without a recipe is refused', noRecipe.status === 400, noRecipe.body.message);

  const cake = await request('POST', '/products', {
    name: 'Butter Cake',
    categoryId,
    unit: 'pcs',
    price: 300,
    productType: 'composite',
    recipe: {
      yieldQty: 4,
      ingredients: [
        { productId: flour.body.data.id, qty: 2 },   // 2 kg  @ 40 = 80
        { productId: butter.body.data.id, qty: 200 } // 200 g @  1 = 200
      ]
    }
  });
  check('Composite created with its recipe', cake.body.success === true, cake.body.message);
  const cakeId = cake.body.data.id;
  check('Cost is derived from the recipe', cake.body.data.purchasePrice === 70, `unit cost ${cake.body.data.purchasePrice} (280 / 4)`);
  check('Margin is positive', cake.body.data.recipe.margin === 230, `margin ${cake.body.data.recipe.margin}`);

  const selfRef = await request('PUT', `/products/${cakeId}`, {
    name: 'Butter Cake', productType: 'composite', price: 300,
    recipe: { yieldQty: 4, ingredients: [{ productId: cakeId, qty: 1 }] }
  });
  check('A recipe cannot contain itself', selfRef.status === 400, selfRef.body.message);

  const recipeRead = await request('GET', `/products/${cakeId}/recipe`);
  check('Recipe reads back off the product', recipeRead.body.data?.ingredients?.length === 2);
  check('Producible count is computed', recipeRead.body.data.producible > 0, `${recipeRead.body.data.producible} unit(s) makeable`);

  const rawDelete = await request('DELETE', `/products/${flour.body.data.id}`);
  check('A raw material in use cannot be deleted', rawDelete.status === 400, rawDelete.body.message);

  section('Module 3 — billing, composite deduction, alternate units');

  await request('POST', '/session/open', { openingCash: 1000 });

  const customer = await request('POST', '/customers', { name: 'Ravi Kumar', phone: '9876500001', group: 'Retail' });
  check('Customer created', customer.body.success === true);
  const customerId = customer.body.data.id;

  const cakeSale = await request('POST', '/orders', {
    customerId,
    customerName: 'Ravi Kumar',
    paymentMethod: 'Cash',
    subtotal: 600, tax: 0, discount: 0, total: 600,
    items: [{ id: cakeId, name: 'Butter Cake', qty: 2, price: 300, total: 600, unit: 'pcs' }]
  });
  check('Composite sale completes', cakeSale.body.success === true);

  const afterFlour = (await request('GET', '/products')).body.data.find((p) => p.id === flour.body.data.id);
  // 2 cakes from a batch of 4 consumes half the batch: 2 kg × 2/4 = 1 kg.
  check('Selling a composite consumes raw materials', afterFlour.stock === 99, `flour ${afterFlour.stock} kg (was 100)`);

  const boxSale = await request('POST', '/orders', {
    paymentMethod: 'Cash',
    subtotal: 460, tax: 0, discount: 0, total: 460,
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 1, price: 460, total: 460, unit: 'box', saleUnit: 'box', unitFactor: 24 }]
  });
  check('Alternate-unit sale completes', boxSale.body.success === true);
  const afterCola = (await request('GET', '/products')).body.data.find((p) => p.id === multi.body.data.id);
  check('One box removes 24 base units', afterCola.stock === 216, `stock ${afterCola.stock} (was 240)`);

  section('Module 3 — loyalty redemption');

  const loyalty = await request('GET', `/customers/${customerId}/loyalty`);
  check('Loyalty balance is readable', loyalty.body.success === true, `${loyalty.body.data.points} pts earned`);

  const overRedeem = await request('POST', '/orders', {
    customerId, customerName: 'Ravi Kumar', paymentMethod: 'Cash',
    subtotal: 100, tax: 0, discount: 0, total: 100,
    redeemPoints: 99999,
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 5, price: 20, total: 100, unit: 'pcs' }]
  });
  check('Redeeming more points than held is refused', overRedeem.status === 400, overRedeem.body.message);

  const belowFloor = await request('POST', '/orders', {
    customerId, customerName: 'Ravi Kumar', paymentMethod: 'Cash',
    subtotal: 100, tax: 0, discount: 0, total: 100,
    redeemPoints: 1,
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 5, price: 20, total: 100, unit: 'pcs' }]
  });
  check('Redemption below the shop minimum is refused', belowFloor.status === 400, belowFloor.body.message);

  // Shops set their own redemption floor; drop it so the happy path can run.
  await request('PUT', '/settings/pos', { loyaltyMinRedeemPoints: 0 });

  const pointsHeld = (await request('GET', `/customers/${customerId}/loyalty`)).body.data.points;
  const redeemed = await request('POST', '/orders', {
    customerId, customerName: 'Ravi Kumar', paymentMethod: 'Cash',
    subtotal: 100, tax: 0, discount: 0, total: 100,
    redeemPoints: Math.min(pointsHeld, 4),
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 5, price: 20, total: 100, unit: 'pcs' }]
  });
  check('Points come off the bill', redeemed.body.data.loyaltyRedeemed > 0, `−₹${redeemed.body.data.loyaltyRedeemed} on a ₹100 bill`);
  check('Total charged is net of points', redeemed.body.data.total === 100 - redeemed.body.data.loyaltyRedeemed);

  section('Module 19 — table management');

  const t1 = await request('POST', '/tables', { name: 'T1', seats: 4 });
  const t2 = await request('POST', '/tables', { name: 'T2', seats: 2 });
  check('Tables created', t1.body.success && t2.body.success);

  const bill1 = await request('POST', '/bills/hold', {
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 2, price: 20, total: 40 }],
    total: 40, tableId: t1.body.data.id
  });
  const bill2 = await request('POST', '/bills/hold', {
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 3, price: 20, total: 60 }],
    total: 60, tableId: t2.body.data.id
  });
  check('Bills held against tables', bill1.body.success && bill2.body.success);

  const merged = await request('POST', '/tables/merge', {
    sourceTableId: t1.body.data.id,
    targetTableId: t2.body.data.id
  });
  check('Tables merge', merged.body.success === true, merged.body.message);
  check('Matching lines combine rather than duplicate', merged.body.data.items.length === 1 && merged.body.data.items[0].qty === 5, `qty ${merged.body.data.items[0]?.qty}`);

  const tablesAfter = (await request('GET', '/tables')).body.data;
  check('The merged-from table is freed', tablesAfter.find((t) => t.id === t1.body.data.id).status === 'FREE');

  section('Module 6 — vendor cash payment');

  const vendor = await request('POST', '/vendors', { name: 'Flour Mills Ltd', phone: '9876500002' });
  const vendorId = vendor.body.data.id;

  await request('POST', '/purchases', {
    vendorId, invoiceNo: 'PUR-001', totalAmount: 5000, paymentStatus: 'UNPAID',
    items: [{ productId: flour.body.data.id, name: 'Wheat Flour', qty: 100, rate: 40, taxRate: 0 }]
  });
  await request('POST', '/purchases', {
    vendorId, invoiceNo: 'PUR-002', totalAmount: 3000, paymentStatus: 'UNPAID',
    items: [{ productId: butter.body.data.id, name: 'Butter', qty: 1000, rate: 1, taxRate: 0 }]
  });

  const payables = await request('GET', '/reports/vendors/payables');
  check('Vendor payables report builds', payables.body.data.totalPayable === 8000, `₹${payables.body.data.totalPayable} payable`);

  const pay = await request('POST', `/vendors/${vendorId}/pay`, { amount: 6000, paymentMode: 'Cash' });
  check('Vendor payment posts', pay.body.success === true, pay.body.message);
  check('Oldest invoice cleared first', pay.body.data.settled[0].invoiceNo === 'PUR-001' && pay.body.data.settled[0].status === 'PAID');
  check('Remainder applied as partial', pay.body.data.settled[1]?.status === 'PARTIAL');
  check('Payable drops to the balance', pay.body.data.outstandingPayable === 2000, `₹${pay.body.data.outstandingPayable} left`);

  section('Module 9/10/16 — reports');

  await request('POST', '/orders', {
    customerId, customerName: 'Ravi Kumar', paymentMethod: 'Credit (Udhar)',
    subtotal: 500, tax: 0, discount: 0, total: 500,
    items: [{ id: multi.body.data.id, name: 'Cola Bottle', qty: 25, price: 20, total: 500, unit: 'pcs' }]
  });

  const outstanding = await request('GET', '/reports/customers/outstanding');
  check('Customer outstanding report builds', outstanding.body.data.totalOutstanding > 0, `₹${outstanding.body.data.totalOutstanding} receivable`);
  check('Ageing buckets are included', Array.isArray(outstanding.body.data.ageing));

  const expenseHeads = await request('GET', '/accounts/expenses');
  const head = expenseHeads.body.data.heads[0];
  await request('POST', '/accounts/expenses', { accountId: head.id, amount: 750, paymentMode: 'Cash', notes: 'Shop electricity' });

  const expenseReport = await request('GET', '/reports/expenses');
  check('Expense report builds', expenseReport.body.data.total === 750, `₹${expenseReport.body.data.total} spent`);
  check('Expenses group by category', expenseReport.body.data.rows.length === 1);

  const cashSummary = await request('GET', '/reports/cash-summary');
  check('Daily cash summary builds', cashSummary.body.success === true, `cash ₹${cashSummary.body.data.cashBalance}, bank ₹${cashSummary.body.data.bankBalance}`);
  check('Cash summary has day rows', cashSummary.body.data.days.length > 0);

  for (const key of ['sales-daily', 'stock', 'customer-outstanding', 'vendor-payables', 'expenses', 'cash-summary']) {
    const exp = await request('GET', `/reports/export/${key}`);
    check(`Export "${key}"`, exp.body.success === true && Array.isArray(exp.body.data.rows));
  }

  section('Module 11 — roles, permissions & module access');

  const users = await request('GET', '/users');
  check('Roles are Owner / Secondary Admin / Cashier', users.body.data.roles.map((r) => r.key).join(',') === 'OWNER,ADMIN,CASHIER');
  check('Module list is published', users.body.data.moduleKeys.includes('reports'));
  check('Plan features accompany the matrix', typeof users.body.data.planFeatures === 'object');

  const cashier = users.body.data.users.find((u) => u.role === 'CASHIER');
  check('Cashier cannot reach reports by default', cashier.effective.modules.reports === false);
  check('Cashier discount is capped', cashier.effective.maxDiscountPercent === 10);

  const grant = await request('PUT', `/users/${cashier.id}/permissions`, {
    modules: { reports: true },
    canAccessReports: true,
    maxDiscountPercent: 15
  });
  check('Permission toggle applies', grant.body.data.effective.modules.reports === true);
  check('Only the difference is stored', grant.body.data.overrides.modules.reports === true && !('billing' in (grant.body.data.overrides.modules || {})));
  check('Discount ceiling raised', grant.body.data.effective.maxDiscountPercent === 15);

  const reset = await request('PUT', `/users/${cashier.id}/permissions`, { reset: true });
  check('Reset restores the role default', reset.body.data.overrides === null && reset.body.data.effective.modules.reports === false);

  const owner = users.body.data.users.find((u) => u.role === 'OWNER');
  const restrictOwner = await request('PUT', `/users/${owner.id}/permissions`, { modules: { reports: false } });
  check('The Owner cannot be restricted', restrictOwner.status === 400, restrictOwner.body.message);

  section('Module 7 — customer groups');

  const groups = await request('GET', '/customer-groups');
  check('Default groups exist', groups.body.data.length >= 4, groups.body.data.map((g) => g.name).join(', '));

  const newGroup = await request('POST', '/customer-groups', { name: 'Corporate', discountPercent: 7 });
  check('Group created', newGroup.body.success === true);

  const assigned = await request('POST', `/customer-groups/${newGroup.body.data.id}/assign`, { customerIds: [customerId] });
  check('Customers allocated to a group', assigned.body.data.moved === 1);

  const busyGroup = await request('DELETE', `/customer-groups/${newGroup.body.data.id}`);
  check('A group with members cannot be deleted', busyGroup.status === 400, busyGroup.body.message);

  section('Module 13 — hardware');

  const weight = await request('GET', '/hardware/weight');
  check('Weighing scale responds', weight.body.success === true, `${weight.body.data.weight} kg`);

  const label = await request('POST', '/hardware/barcode-label', { productId: multi.body.data.id, quantity: 2 });
  check('Barcode label generated', label.body.success === true, label.body.data.encoded);

  section('Module 17 — session tracking');

  const cashOut = await request('POST', '/session/cash-entry', { type: 'OUT', amount: 200, reason: 'Tea for staff' });
  check('Cash out recorded', cashOut.body.success === true, `drawer ₹${cashOut.body.data.session.currentCash}`);

  const close = await request('POST', '/session/close', { countedCash: cashOut.body.data.session.currentCash });
  check('Session closes with no variance', close.body.data.variance === 0, `variance ₹${close.body.data.variance}`);

  const sessions = await request('GET', '/reports/sessions');
  check('Session history retained', sessions.body.data.length > 0);

  section('Accounting integrity');

  const tb = await request('GET', '/accounts/reports/trial-balance');
  check('Trial balance balances', tb.body.data.isBalanced === true, `difference ₹${tb.body.data.difference}`);

  const bs = await request('GET', '/accounts/reports/balance-sheet');
  check('Balance sheet balances', bs.body.data.isBalanced === true, `difference ₹${bs.body.data.difference}`);

  /* ---------------------------------------------------------------- */

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${passed} passed · ${failed} failed`);
  if (failed) {
    console.log('\n  Failing checks:');
    failures.forEach((f) => console.log(`    · ${f}`));
  }
  console.log(`${'═'.repeat(64)}\n`);

  return failed;
}

(async () => {
  let code = 1;
  let server;
  try {
    await setup();
    server = app.listen(PORT);
    await new Promise((resolve) => server.once('listening', resolve));
    code = await run();
  } catch (err) {
    console.error('\n💥 Test run crashed:', err);
  } finally {
    await teardown().catch(() => {});
    if (server) server.close();
    await mongoose.disconnect().catch(() => {});
    process.exit(code ? 1 : 0);
  }
})();
