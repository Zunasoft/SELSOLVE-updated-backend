/**
 * Internal end-to-end check for the features built/fixed this session that
 * test_modules.js does not cover: price sheets in billing, the full quotation
 * lifecycle, purchase auto-product-creation + duplicate guard + void, order
 * void, settings persistence, and customer/vendor GST/PAN fields.
 *
 * Same harness pattern as test_modules.js: a disposable test tenant is
 * written to the master DB with its own isolated database, everything runs
 * against the real Express app, and both are dropped again when the run
 * finishes (see the `finally` block).
 *
 *   node test_session_features.js          (needs ADMIN_BE_URL / MONGODB_URI set)
 */

process.env.NODE_ENV = 'test';

const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('./server.js');
const { models, ensureMasterDB } = require('./db');
const config = require('./config/config');
const { featuresForPlan } = require('./modules/features');

const PORT = 5198;

const TENANT = {
  id: 't_test2',
  tenantId: 'testshop2',
  name: 'Test Shop 2',
  slug: 'testshop2',
  email: 'owner@testshop2.com',
  phone: '+91 9000000000',
  dbName: 'tenant_db_testshop2',
  status: 'active',
  plan: 'enterprise',
  expiryDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
  maxDevices: 25,
  createdAt: new Date().toISOString()
};

let PLANS = [];
const planById = (id) => PLANS.find((p) => p.id === id) || null;

async function setup() {
  if (!(await ensureMasterDB())) {
    throw new Error('MongoDB is unreachable — set ADMIN_BE_URL (or MONGODB_URI) before running the suite.');
  }
  PLANS = await models.Plan.find().lean();
  TENANT.features = featuresForPlan(planById('enterprise'), 'enterprise');
  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  await models.Tenant.findOneAndUpdate({ id: TENANT.id }, TENANT, { upsert: true });
}

async function teardown() {
  await models.Tenant.deleteOne({ id: TENANT.id });
  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
}

const TOKEN = jwt.sign(
  { tenantId: TENANT.tenantId, name: TENANT.name, email: TENANT.email, dbName: TENANT.dbName, slug: TENANT.slug, plan: TENANT.plan, role: 'Owner' },
  config.JWT_SECRET,
  { expiresIn: '1h' }
);

function request(method, path, body = null) {
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
          Authorization: `Bearer ${TOKEN}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(label); console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (name) => console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);

async function run() {
  section('Setup — catalog & parties');

  const cat = await request('POST', '/categories', { name: 'General', icon: '📦' });
  const categoryId = cat.body.data.id;

  const soap = await request('POST', '/products', {
    name: 'Bath Soap', categoryId, unit: 'pcs', price: 50, purchasePrice: 30, stock: 200, barcode: '9000000001', hsn: '3401'
  });
  const soapId = soap.body.data.id;

  const oil = await request('POST', '/products', {
    name: 'Hair Oil', categoryId, unit: 'pcs', price: 120, purchasePrice: 80, stock: 100, barcode: '9000000002', hsn: '3305'
  });
  const oilId = oil.body.data.id;

  const vip = await request('POST', '/customers', {
    name: 'Priya VIP', phone: '9998887771', group: 'VIP', gstin: '33AAAAA0000A1Z5', pan: 'AAAAA0000A', state: 'Tamil Nadu', stateCode: '33'
  });
  check('Customer created with GSTIN/PAN/state', vip.body.success === true);
  check('GSTIN persisted', vip.body.data.gstin === '33AAAAA0000A1Z5');
  check('PAN persisted', vip.body.data.pan === 'AAAAA0000A');
  check('State + code persisted', vip.body.data.state === 'Tamil Nadu' && vip.body.data.stateCode === '33');
  const vipId = vip.body.data.id;

  const vendorRes = await request('POST', '/vendors', { name: 'Daily Supplies Co', phone: '9998887772', pan: 'BBBBB1111B' });
  check('Vendor PAN persisted', vendorRes.body.data.pan === 'BBBBB1111B');
  const vendorId = vendorRes.body.data.id;

  section('Price sheets');

  const sheet = await request('POST', '/price-sheets', {
    name: 'VIP Sheet',
    customerType: 'VIP',
    isActive: true,
    pricingMap: { [soapId]: 40 },
    discountMap: { [oilId]: 10 }
  });
  check('Price sheet created', sheet.body.success === true, sheet.body.message || '');
  const sheetId = sheet.body?.data?.id;

  const sheetList = await request('GET', '/price-sheets');
  check('Price sheet listed', Array.isArray(sheetList.body.data) && sheetList.body.data.some((s) => s.id === sheetId));

  const assignSheet = await request('PUT', `/customers/${vipId}`, { priceSheetId: sheetId });
  check('Price sheet assignable to a customer', assignSheet.body.data.priceSheetId === sheetId);

  section('Purchases — auto product creation, duplicate guard, void');

  const purchaseWithNew = await request('POST', '/purchases', {
    vendorId, invoiceNo: 'DUP-01', paymentStatus: 'UNPAID',
    items: [
      { productId: soapId, name: 'Bath Soap', unit: 'pcs', qty: 50, rate: 30, taxRate: 0 },
      { productId: null, name: 'Shampoo Sachet', unit: 'pcs', hsn: '3305', qty: 100, rate: 5, taxRate: 0 }
    ]
  });
  check('Purchase with a new (non-catalog) line succeeds', purchaseWithNew.body.success === true, purchaseWithNew.body.message);
  check('New product auto-created', (purchaseWithNew.body.createdProducts || []).some((p) => p.name === 'Shampoo Sachet'));
  const purchaseId = purchaseWithNew.body.data?.id;

  const productsAfterPurchase = await request('GET', '/products');
  const shampoo = productsAfterPurchase.body.data.find((p) => p.name === 'Shampoo Sachet');
  check('Auto-created product now in catalog with stock', Boolean(shampoo) && shampoo.stock === 100, shampoo ? `stock ${shampoo.stock}` : 'not found');
  check('Auto-created product carries the given HSN', shampoo?.hsn === '3305');

  const soapAfterPurchase = productsAfterPurchase.body.data.find((p) => p.id === soapId);
  check('Existing product stock increased by purchase qty', soapAfterPurchase.stock === 250, `stock ${soapAfterPurchase.stock} (was 200 + 50)`);

  const dupInvoice = await request('POST', '/purchases', {
    vendorId, invoiceNo: 'DUP-01', paymentStatus: 'UNPAID',
    items: [{ productId: soapId, name: 'Bath Soap', unit: 'pcs', qty: 10, rate: 30, taxRate: 0 }]
  });
  check('Duplicate vendor+invoice number is rejected', dupInvoice.status === 409, dupInvoice.body.message);

  const vendorBeforeVoid = await request('GET', '/vendors');
  const vBefore = vendorBeforeVoid.body.data.find((v) => v.id === vendorId);

  const voidPurchase = await request('POST', `/purchases/${purchaseId}/void`);
  check('Purchase voids successfully', voidPurchase.body.success === true, voidPurchase.body.message);

  const productsAfterVoid = await request('GET', '/products');
  const soapAfterVoid = productsAfterVoid.body.data.find((p) => p.id === soapId);
  check('Voiding a purchase pulls the received stock back out', soapAfterVoid.stock === 200, `stock ${soapAfterVoid.stock} (expected back to 200)`);

  const reVoid = await request('POST', `/purchases/${purchaseId}/void`);
  check('Voiding an already-voided purchase is rejected', reVoid.status === 400, reVoid.body.message);

  const vendorAfterVoid = await request('GET', '/vendors');
  const vAfter = vendorAfterVoid.body.data.find((v) => v.id === vendorId);
  check('Voided purchase drops out of vendor purchaseCount', vAfter.purchaseCount === vBefore.purchaseCount - 1, `${vAfter.purchaseCount} (was ${vBefore.purchaseCount})`);
  check('Voided purchase drops out of vendor totalPurchased', vAfter.totalPurchased < vBefore.totalPurchased);

  const purchasesReport = await request('GET', '/reports/purchases');
  check('Voided purchase excluded from purchases report', !purchasesReport.body.data.rows.some((p) => p.id === purchaseId));

  const purchaseListStillShowsIt = await request('GET', '/purchases');
  const listedVoided = purchaseListStillShowsIt.body.data.find((p) => p.id === purchaseId);
  check('Voided purchase still visible in the raw list with VOID status (audit trail kept)', listedVoided && listedVoided.status === 'VOID');

  section('Billing — session, cart, checkout with GST customer fields');

  await request('POST', '/session/open', { openingCash: 2000 });

  const sale = await request('POST', '/orders', {
    customerId: vipId,
    customerName: 'Priya VIP',
    customerGstin: '33AAAAA0000A1Z5',
    customerPan: 'AAAAA0000A',
    customerState: 'Tamil Nadu',
    customerStateCode: '33',
    paymentMethod: 'Cash',
    subtotal: 40, tax: 0, discount: 0, total: 40,
    items: [{ id: soapId, name: 'Bath Soap', qty: 1, price: 40, total: 40, unit: 'pcs', hsn: '3401' }]
  });
  check('Sale with price-sheet-resolved price completes', sale.body.success === true);
  check('Order carries customer GSTIN/PAN/state through', sale.body.data.customerGstin === '33AAAAA0000A1Z5' && sale.body.data.customerState === 'Tamil Nadu');
  check('Order item retains HSN', sale.body.data.items[0].hsn === '3401');
  const orderId = sale.body.data.orderId;

  const badQty = await request('POST', '/orders', {
    paymentMethod: 'Cash', subtotal: -50, tax: 0, discount: 0, total: -50,
    items: [{ id: soapId, name: 'Bath Soap', qty: -1, price: 50, total: -50, unit: 'pcs' }]
  });
  check('Negative quantity sale is rejected', badQty.status === 400, badQty.body.message);

  const stockBeforeVoidOrder = (await request('GET', '/products')).body.data.find((p) => p.id === soapId).stock;
  const voidOrder = await request('POST', `/orders/${orderId}/void`);
  check('Order voids successfully', voidOrder.body.success === true, voidOrder.body.message);
  const stockAfterVoidOrder = (await request('GET', '/products')).body.data.find((p) => p.id === soapId).stock;
  check('Voiding an order restores stock', stockAfterVoidOrder === stockBeforeVoidOrder + 1, `${stockAfterVoidOrder} (was ${stockBeforeVoidOrder})`);

  const reVoidOrder = await request('POST', `/orders/${orderId}/void`);
  check('Voiding an already-voided order is rejected', reVoidOrder.status === 400, reVoidOrder.body.message);

  section('Quotations — full lifecycle');

  const quote1 = await request('POST', '/quotations', {
    customerId: vipId, customerName: 'Priya VIP',
    subtotal: 120, tax: 0, discount: 0, total: 120,
    items: [{ id: oilId, name: 'Hair Oil', qty: 1, price: 120, total: 120, unit: 'pcs', hsn: '3305' }]
  });
  check('Quotation created', quote1.body.success === true);
  check('Quotation numbering starts at 1001', quote1.body.data.quotationNo === 'QUO-1001' || /1001/.test(String(quote1.body.data.quotationNo)), String(quote1.body.data.quotationNo));
  const quote1Id = quote1.body.data.id;

  const quote2 = await request('POST', '/quotations', {
    customerId: vipId, customerName: 'Priya VIP',
    subtotal: 240, tax: 0, discount: 0, total: 240,
    items: [{ id: oilId, name: 'Hair Oil', qty: 2, price: 120, total: 240, unit: 'pcs' }]
  });
  const quote2Id = quote2.body.data.id;

  const deleteQ1 = await request('DELETE', `/quotations/${quote1Id}`);
  check('Non-converted quotation deletes', deleteQ1.body.success === true, deleteQ1.body.message);

  const quote3 = await request('POST', '/quotations', {
    customerId: vipId, customerName: 'Priya VIP',
    subtotal: 50, tax: 0, discount: 0, total: 50,
    items: [{ id: soapId, name: 'Bath Soap', qty: 1, price: 50, total: 50, unit: 'pcs' }]
  });
  check(
    'Quotation numbering does not reuse a deleted number',
    quote3.body.data.quotationNo !== quote1.body.data.quotationNo,
    `${quote1.body.data.quotationNo} then ${quote3.body.data.quotationNo}`
  );

  const editQ2 = await request('PUT', `/quotations/${quote2Id}`, {
    customerId: vipId, customerName: 'Priya VIP',
    subtotal: 360, tax: 0, discount: 0, total: 360,
    items: [{ id: oilId, name: 'Hair Oil', qty: 3, price: 120, total: 360, unit: 'pcs' }]
  });
  check('Quotation edits before conversion', editQ2.body.success === true && editQ2.body.data.total === 360);

  const convert = await request('POST', `/quotations/${quote2Id}/convert`, { paymentMethod: 'Cash' });
  check('Quotation converts to an invoice', convert.body.success === true, convert.body.message);
  const convertedOrderId = convert.body.data?.order?.orderId;
  check('Converted order carries the quotation total', convert.body.data?.order?.total === 360);

  const reconvert = await request('POST', `/quotations/${quote2Id}/convert`, { paymentMethod: 'Cash' });
  check('Re-converting an already-converted quotation is rejected', reconvert.status === 400, reconvert.body.message);

  const editConverted = await request('PUT', `/quotations/${quote2Id}`, {
    customerId: vipId, customerName: 'Priya VIP', subtotal: 1, tax: 0, discount: 0, total: 1,
    items: [{ id: oilId, name: 'Hair Oil', qty: 1, price: 1, total: 1, unit: 'pcs' }]
  });
  check('A converted quotation cannot be edited', editConverted.status === 400, editConverted.body.message);

  const deleteConverted = await request('DELETE', `/quotations/${quote2Id}`);
  check('A converted quotation cannot be deleted', deleteConverted.status === 400, deleteConverted.body.message);

  section('Settings — company, billing, bank details');

  const companySave = await request('PUT', '/settings/company', {
    name: 'Test Shop 2', pan: 'CCCCC2222C', cinNo: 'U12345TN2020PTC000000', contactName: 'Priya Owner'
  });
  check('Company settings save', companySave.body.success === true);
  check('Company PAN persisted', companySave.body.data.pan === 'CCCCC2222C');

  const billingSave = await request('PUT', '/settings/billing', {
    bankAccountName: 'Test Shop 2', bankName: 'HDFC Bank', bankAccountNumber: '1234567890', bankIfsc: 'HDFC0000123', upiId: 'testshop2@upi'
  });
  check('Billing/bank settings save', billingSave.body.success === true);
  check('UPI ID persisted', billingSave.body.data.upiId === 'testshop2@upi');

  const unknownSection = await request('PUT', '/settings/does-not-exist', { foo: 'bar' });
  check('Saving an unknown settings section is rejected', unknownSection.status === 404, unknownSection.body.message);

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
