/**
 * Comprehensive End-to-End System Test Run for Selsolve POS
 * Tests every section, every feature, and realistic retail/store scenarios.
 */

process.env.NODE_ENV = 'test';

const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = require('./server.js');
const { models, ensureMasterDB } = require('./db');
const config = require('./config/config');
const { featuresForPlan } = require('./modules/features');
const engine = require('./accounting/engine');

const PORT = 5299;

const TENANT = {
  id: 't_comprehensive_test',
  tenantId: 'comprehensive_shop',
  name: 'Selsolve Supermarket & Bakery',
  slug: 'selsolve-supermarket',
  email: 'owner@selsolveshop.com',
  phone: '+91 9876543210',
  dbName: 'tenant_db_comprehensive_test',
  status: 'active',
  plan: 'enterprise',
  expiryDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
  maxDevices: 50,
  createdAt: new Date().toISOString()
};

let server;
let token;
let totalChecks = 0;
let passedChecks = 0;
let failedChecks = [];

function check(label, condition, detail = '') {
  totalChecks++;
  if (condition) {
    passedChecks++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failedChecks.push({ label, detail });
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  ${title}`);
  console.log(`════════════════════════════════════════════════════════════════`);
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: `/api/pos${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-tenant-id': TENANT.tenantId,
          'x-user-name': 'Owner Admin',
          'x-user-role': 'Owner',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runAllTests() {
  console.log('🚀 Starting Comprehensive System Test Run on Selsolve POS...');

  if (!(await ensureMasterDB())) {
    throw new Error('MongoDB unreachable');
  }

  const plans = await models.Plan.find().lean();
  TENANT.features = featuresForPlan(plans.find((p) => p.id === 'enterprise'), 'enterprise');

  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  await models.Tenant.findOneAndUpdate({ id: TENANT.id }, TENANT, { upsert: true });

  token = jwt.sign(
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
    { expiresIn: '1d' }
  );

  server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 600));

  /* ------------------------------------------------------------------ *
   * SECTION 1: System Boot & App Initialization
   * ------------------------------------------------------------------ */
  section('SECTION 1: System Boot, Auth & App Initialization');
  const initRes = await request('GET', '/init');
  check('POS Initial Data (/init) boots successfully', initRes.status === 200 && initRes.body.success === true);
  check('Categories loaded', Array.isArray(initRes.body.data.categories));
  check('Products loaded', Array.isArray(initRes.body.data.products));
  check('Customers enriched with live balances', Array.isArray(initRes.body.data.customers));
  check('Settings structure exists', Boolean(initRes.body.data.settings));

  /* ------------------------------------------------------------------ *
   * SECTION 2: Category Management & Color Theme Customization
   * ------------------------------------------------------------------ */
  section('SECTION 2: Category Management with Distinct Colors');
  
  // 1. Create Bakery category with Orange color
  const catBakery = await request('POST', '/categories', {
    name: 'Bakery & Fresh Breads',
    icon: '🍞',
    description: 'Fresh artisanal breads, cakes and cookies',
    color: 'orange'
  });
  check('Created category with custom color "orange"', catBakery.status === 201 && catBakery.body.data.color === 'orange');
  const bakeryCatId = catBakery.body.data.id;

  // 2. Create Dairy category with Sky Blue color
  const catDairy = await request('POST', '/categories', {
    name: 'Dairy & Milk Products',
    icon: '🥛',
    color: 'sky'
  });
  check('Created category with custom color "sky"', catDairy.status === 201 && catDairy.body.data.color === 'sky');
  const dairyCatId = catDairy.body.data.id;

  // 3. Create Beverages category with Purple color
  const catBev = await request('POST', '/categories', {
    name: 'Cold Beverages & Juices',
    icon: '🧃',
    color: 'purple'
  });
  check('Created category with custom color "purple"', catBev.status === 201 && catBev.body.data.color === 'purple');
  const bevCatId = catBev.body.data.id;

  // 4. Update category color to Rose
  const updateCat = await request('PUT', `/categories/${dairyCatId}`, {
    name: 'Dairy & Premium Cheeses',
    color: 'rose'
  });
  check('Updated category color to "rose"', updateCat.status === 200 && updateCat.body.data.color === 'rose');

  /* ------------------------------------------------------------------ *
   * SECTION 3: Inventory Products, Multi-Units, Recipes & Composite Items
   * ------------------------------------------------------------------ */
  section('SECTION 3: Products, Alternate Units, Barcodes & Recipes');

  // 1. Create Raw Material 1: Organic Wheat Flour
  const flour = await request('POST', '/products', {
    name: 'Organic Wheat Flour',
    categoryId: bakeryCatId,
    unit: 'kg',
    price: 50,
    purchasePrice: 35,
    stock: 200,
    productType: 'raw',
    hsn: '11010000'
  });
  check('Raw Material 1 (Wheat Flour) created', flour.status === 201 && flour.body.data.stock === 200);

  // 2. Create Raw Material 2: Pure Amul Butter
  const butter = await request('POST', '/products', {
    name: 'Pure Amul Butter',
    categoryId: dairyCatId,
    unit: 'g',
    price: 0.80,
    purchasePrice: 0.50,
    stock: 5000,
    productType: 'raw',
    hsn: '04050000'
  });
  check('Raw Material 2 (Pure Butter) created', butter.status === 201 && butter.body.data.stock === 5000);

  // 3. Create Composite / Recipe Item: Chocolate Croissant
  // Batch of 10 croissants consumes 1 kg Flour (35) + 500 g Butter (250) = 285 cost -> 28.50/croissant
  const croissant = await request('POST', '/products', {
    name: 'Artisan Chocolate Croissant',
    categoryId: bakeryCatId,
    unit: 'pcs',
    price: 90,
    productType: 'composite',
    recipe: {
      yieldQty: 10,
      ingredients: [
        { productId: flour.body.data.id, qty: 1 },    // 1 kg flour
        { productId: butter.body.data.id, qty: 500 }  // 500 g butter
      ]
    }
  });
  check('Composite Recipe Item created', croissant.status === 201);
  check('Recipe unit cost calculated correctly (₹28.50)', croissant.body.data.purchasePrice === 28.5);
  check('Recipe margin computed (₹61.50)', croissant.body.data.recipe.margin === 61.5);
  const croissantId = croissant.body.data.id;

  // Check producible estimate
  const recipeInfo = await request('GET', `/products/${croissantId}/recipe`);
  check('Producible croissant count calculated (100 pcs makeable)', recipeInfo.body.data.producible === 100);

  // 4. Create Standard Product with Alternate Units & Multiple Barcodes: Cold Pressed Mango Juice
  const juice = await request('POST', '/products', {
    name: 'Cold Pressed Mango Juice 300ml',
    categoryId: bevCatId,
    unit: 'bottle',
    price: 60,
    purchasePrice: 40,
    stock: 360,
    barcodes: ['890100000001', '890100000002'],
    altUnits: [
      { unit: 'case', factor: 12, price: 660, isAlt: true } // Case of 12 bottles @ ₹660 (discounted)
    ]
  });
  check('Multi-unit product with secondary barcodes created', juice.status === 201);
  const juiceId = juice.body.data.id;

  // Lookup by secondary barcode
  const lookup = await request('GET', '/products/lookup/890100000002');
  check('Lookup by secondary barcode succeeds', lookup.status === 200 && lookup.body.data.id === juiceId);

  // 5. Create Scale-Weighed Produce Item
  const apples = await request('POST', '/products', {
    name: 'Fresh Kashmiri Apples',
    categoryId: bakeryCatId,
    unit: 'kg',
    price: 180,
    purchasePrice: 120,
    stock: 50,
    requiresWeight: true
  });
  check('Weighing-scale produce item created', apples.status === 201 && apples.body.data.requiresWeight === true);
  const applesId = apples.body.data.id;

  /* ------------------------------------------------------------------ *
   * SECTION 4: Customer Management, Loyalty Points & Advance Store Credit
   * ------------------------------------------------------------------ */
  section('SECTION 4: Customers, Groups, Loyalty & Advance Credit');

  // 1. Customer A: Advance Store Credit Holder (Shop owes him ₹1,200 from past deposit/return)
  const custAdvance = await request('POST', '/customers', {
    name: 'Vikram Malhotra',
    phone: '9876500011',
    group: 'VIP',
    creditLimit: 5000,
    openingAdvance: 1200,
    loyaltyPoints: 80
  });
  check('Customer A created with Opening Advance of ₹1,200 and 80 loyalty pts', custAdvance.status === 201);
  const custAdvanceId = custAdvance.body.data.id;

  // 2. Customer B: Standard Retail Customer
  const custRetail = await request('POST', '/customers', {
    name: 'Ananya Sharma',
    phone: '9876500022',
    group: 'Retail',
    creditLimit: 2000,
    openingBalance: 0,
    loyaltyPoints: 0
  });
  check('Customer B (Retail) created', custRetail.status === 201);
  const custRetailId = custRetail.body.data.id;

  // Verify Customer A advance in customer list
  const custList = await request('GET', '/customers');
  const foundA = custList.body.data.find((c) => c.id === custAdvanceId);
  check('Customer A displays ₹1,200 advance in directory', foundA && foundA.advance === 1200);

  /* ------------------------------------------------------------------ *
   * SECTION 5: Vendors, Purchases & Payables Settle
   * ------------------------------------------------------------------ */
  section('SECTION 5: Vendors, Purchases & Vendor Payments');

  const vendor = await request('POST', '/vendors', {
    name: 'Pristine Farms & Mills',
    phone: '9876500099',
    gstin: '07AAAAA0000A1Z5'
  });
  check('Vendor created', vendor.status === 201);
  const vendorId = vendor.body.data.id;

  // Post new purchase invoice 1 for 100 kg flour @ ₹35 = ₹3,500
  const purchase1 = await request('POST', '/purchases', {
    vendorId,
    vendorName: 'Pristine Farms & Mills',
    invoiceNo: 'PUR-001',
    paymentStatus: 'UNPAID',
    totalAmount: 3500,
    items: [
      { productId: flour.body.data.id, name: 'Organic Wheat Flour', qty: 100, unit: 'kg', rate: 35, taxRate: 0 }
    ]
  });
  check('Purchase Invoice 1 posted (PUR-001: ₹3,500)', purchase1.status === 201);

  // Post purchase invoice 2 for 2000 g butter @ ₹0.50 = ₹1,000
  const purchase2 = await request('POST', '/purchases', {
    vendorId,
    invoiceNo: 'PUR-002',
    paymentStatus: 'UNPAID',
    totalAmount: 1000,
    items: [
      { productId: butter.body.data.id, name: 'Pure Amul Butter', qty: 2000, unit: 'g', rate: 0.50, taxRate: 0 }
    ]
  });
  check('Purchase Invoice 2 posted (PUR-002: ₹1,000)', purchase2.status === 201);

  // Check flour stock increased by 100 (was 200 -> now 300)
  const flourAfterPur = (await request('GET', '/products')).body.data.find((p) => p.id === flour.body.data.id);
  check('Flour inventory stock increased to 300 kg', flourAfterPur.stock === 300);

  // Check Vendor Payables report (3500 + 1000 = 4500)
  const payables = await request('GET', '/reports/vendors/payables');
  check('Vendor Payables report shows ₹4,500 payable', payables.body.data.totalPayable === 4500, `₹${payables.body.data.totalPayable} payable`);

  // Pay vendor ₹3,000 cash
  const payVendor = await request('POST', `/vendors/${vendorId}/pay`, { amount: 3000, paymentMode: 'Cash' });
  check('Vendor payment posted', payVendor.status === 201 && payVendor.body.success === true);
  check('Oldest invoice (PUR-001) partially cleared and remaining payable is ₹1,500', payVendor.body.data.outstandingPayable === 1500, `₹${payVendor.body.data.outstandingPayable} left`);

  /* ------------------------------------------------------------------ *
   * SECTION 6: POS Billing Engine, Composite Consumption & Alternate Units
   * ------------------------------------------------------------------ */
  section('SECTION 6: POS Billing, Recipes & Inventory Reflection');

  // Open Shift Session with ₹2,000 float
  const openSession = await request('POST', '/session/open', { openingCash: 2000 });
  check('POS Shift Session opened with ₹2,000 cash float', openSession.status === 200);

  // SALE 1: Composite Item Sale (5 Croissants @ ₹90 = ₹450)
  // Consumes 5/10 batch -> 0.5 kg flour (300 -> 299.5) and 250 g butter (7000 -> 6750)
  const sale1 = await request('POST', '/orders', {
    customerId: custRetailId,
    customerName: 'Ananya Sharma',
    paymentMethod: 'Cash',
    subtotal: 450,
    tax: 0,
    discount: 0,
    total: 450,
    items: [
      { id: croissantId, name: 'Artisan Chocolate Croissant', qty: 5, price: 90, total: 450, unit: 'pcs' }
    ]
  });
  check('Sale 1 (Composite Croissants) completed', sale1.status === 201 && sale1.body.success === true);

  // Verify stock deduction for composite ingredients
  const flourStock = (await request('GET', '/products')).body.data.find((p) => p.id === flour.body.data.id);
  const butterStock = (await request('GET', '/products')).body.data.find((p) => p.id === butter.body.data.id);
  check('Flour raw material consumed proportionally (299.5 kg remaining)', flourStock.stock === 299.5, `${flourStock.stock} kg`);
  check('Butter raw material consumed proportionally (6750 g remaining)', butterStock.stock === 6750, `${butterStock.stock} g`);

  // SALE 2: Alternate-unit Sale (2 Cases of Mango Juice = 24 bottles)
  // Initial stock was 360 bottles -> after selling 2 cases (24 bottles) -> 336 bottles remaining
  const sale2 = await request('POST', '/orders', {
    customerId: custRetailId,
    customerName: 'Ananya Sharma',
    paymentMethod: 'Cash',
    subtotal: 1320,
    tax: 0,
    discount: 0,
    total: 1320,
    items: [
      { id: juiceId, name: 'Cold Pressed Mango Juice 300ml', qty: 2, price: 660, total: 1320, unit: 'case', saleUnit: 'case', unitFactor: 12 }
    ]
  });
  check('Sale 2 (Alternate Unit: 2 Cases of Juice) completed', sale2.status === 201);
  const juiceStock = (await request('GET', '/products')).body.data.find((p) => p.id === juiceId);
  check('Juice stock reduced by 24 base units (336 bottles remaining)', juiceStock.stock === 336, `${juiceStock.stock} bottles`);

  /* ------------------------------------------------------------------ *
   * SECTION 7: Advance / Store Credit Deduction & Loyalty Redemption
   * ------------------------------------------------------------------ */
  section('SECTION 7: Customer Advance / Store Credit & Loyalty Deduction');

  // SALE 3: Customer A buys ₹600 of goods and DEDUCTS ₹400 from his ₹1,200 Advance Balance
  // Bill = ₹600. Advance Deducted = ₹400. Payable remaining in Cash = ₹200.
  const sale3 = await request('POST', '/orders', {
    customerId: custAdvanceId,
    customerName: 'Vikram Malhotra',
    paymentMethod: 'Cash',
    subtotal: 600,
    tax: 0,
    discount: 0,
    total: 600,
    redeemAdvanceAmount: 400,
    items: [
      { id: juiceId, name: 'Cold Pressed Mango Juice 300ml', qty: 10, price: 60, total: 600, unit: 'bottle' }
    ]
  });
  check('Sale 3 with Customer Advance deduction completed', sale3.status === 201);
  check('Receipt shows advanceRedeemed = ₹400', sale3.body.data.advanceRedeemed === 400);
  check('Payable total net of advance is ₹200', sale3.body.data.total === 200);

  // Verify Customer A advance dropped from ₹1,200 to ₹800
  const custAfterSale3 = (await request('GET', '/customers')).body.data.find((c) => c.id === custAdvanceId);
  check('Customer A advance balance updated to ₹800 (was ₹1,200)', custAfterSale3.advance === 800, `advance: ${custAfterSale3.advance}`);

  // SALE 4: Full Advance Settlement (Bill ₹500, covered completely by ₹500 from remaining ₹800 Advance)
  // Payable Total = ₹0.00. Payment method becomes "Advance / Store Credit"
  const sale4 = await request('POST', '/orders', {
    customerId: custAdvanceId,
    customerName: 'Vikram Malhotra',
    paymentMethod: 'Cash',
    subtotal: 500,
    tax: 0,
    discount: 0,
    total: 500,
    redeemAdvanceAmount: 500,
    items: [
      { id: applesId, name: 'Fresh Kashmiri Apples', qty: 2.5, price: 180, total: 450, unit: 'kg' },
      { id: flour.body.data.id, name: 'Organic Wheat Flour', qty: 1, price: 50, total: 50, unit: 'kg' }
    ]
  });
  check('Sale 4 fully settled via Customer Advance (₹0.00 payable)', sale4.status === 201);
  check('Order payment method recorded as "Advance / Store Credit"', sale4.body.data.paymentMethod === 'Advance / Store Credit');
  check('Order total payable is ₹0.00', sale4.body.data.total === 0);

  // Verify Customer A advance is now ₹300 (800 - 500)
  const custAfterSale4 = (await request('GET', '/customers')).body.data.find((c) => c.id === custAdvanceId);
  check('Customer A advance balance correctly remains at ₹300', custAfterSale4.advance === 300, `advance: ${custAfterSale4.advance}`);

  // SALE 5: Loyalty Points Redemption (Redeem 50 pts @ ₹0.50 = ₹25 discount on ₹300 bill)
  const sale5 = await request('POST', '/orders', {
    customerId: custAdvanceId,
    customerName: 'Vikram Malhotra',
    paymentMethod: 'Cash',
    subtotal: 300,
    tax: 0,
    discount: 0,
    total: 300,
    redeemPoints: 50,
    items: [
      { id: juiceId, name: 'Cold Pressed Mango Juice 300ml', qty: 5, price: 60, total: 300, unit: 'bottle' }
    ]
  });
  check('Sale 5 with Loyalty Redemption completed', sale5.status === 201);
  check('Loyalty discount of ₹25 applied on ₹300 bill (payable ₹275)', sale5.body.data.total === 275);

  /* ------------------------------------------------------------------ *
   * SECTION 8: Held Bills, Quotations & Credit Sales (Udhar)
   * ------------------------------------------------------------------ */
  section('SECTION 8: Held Bills, Quotations & Credit (Udhar) Sales');

  // Hold a bill
  const hold = await request('POST', '/bills/hold', {
    customerName: 'Walk-in Customer',
    items: [{ id: juiceId, name: 'Cold Pressed Mango Juice', qty: 3, price: 60, total: 180, unit: 'bottle' }],
    total: 180
  });
  check('Bill held successfully', (hold.status === 200 || hold.status === 201) && hold.body.success === true);

  // Resume the held bill
  const heldList = await request('GET', '/bills/held');
  check('Held bills listed', heldList.body.data.length > 0);
  const heldId = heldList.body.data[0].id;
  const resume = await request('DELETE', `/bills/held/${heldId}`);
  check('Held bill resumed and removed from hold shelf', resume.status === 200);

  // Save Quotation
  const quote = await request('POST', '/quotations', {
    customerName: 'Ananya Sharma',
    customerId: custRetailId,
    items: [{ productId: juiceId, name: 'Cold Pressed Mango Juice', qty: 10, price: 60, total: 600, unit: 'bottle' }],
    total: 600
  });
  check('Quotation saved successfully', quote.status === 201 && quote.body.success === true);

  // Credit Sale (Udhar) for Ananya: ₹800 credit sale
  const creditSale = await request('POST', '/orders', {
    customerId: custRetailId,
    customerName: 'Ananya Sharma',
    paymentMethod: 'Credit (Udhar)',
    subtotal: 800,
    tax: 0,
    discount: 0,
    total: 800,
    items: [
      { id: applesId, name: 'Fresh Kashmiri Apples', qty: 4, price: 180, total: 720, unit: 'kg' },
      { id: flour.body.data.id, name: 'Organic Wheat Flour', qty: 1.6, price: 50, total: 80, unit: 'kg' }
    ]
  });
  check('Credit (Udhar) sale completed', creditSale.status === 201);

  // Verify Customer B outstanding due is now ₹800
  const custBAfter = (await request('GET', '/customers')).body.data.find((c) => c.id === custRetailId);
  check('Customer B (Ananya) shows ₹800 outstanding due', custBAfter.outstanding === 800, `due: ${custBAfter.outstanding}`);

  /* ------------------------------------------------------------------ *
   * SECTION 9: Session Tracking, Cash In/Out & Shift Close
   * ------------------------------------------------------------------ */
  section('SECTION 9: Cash Drawer, Shift In/Out & Reconciliation');

  // Record Cash In: ₹500
  const cashIn = await request('POST', '/session/cash-entry', { type: 'IN', amount: 500, reason: 'Small Change Addition' });
  check('Cash In (₹500) recorded in session drawer', cashIn.status === 200);

  // Record Cash Out: ₹300 (e.g. Milk packet local purchase)
  const cashOut = await request('POST', '/session/cash-entry', { type: 'OUT', amount: 300, reason: 'Local Tea & Coffee expense' });
  check('Cash Out (₹300) recorded in session drawer', cashOut.status === 200);

  // Close Session with exact counted cash
  const sessionStatus = (await request('GET', '/init')).body.data.session;
  const closeRes = await request('POST', '/session/close', { closingCash: sessionStatus.currentCash });
  check('Shift session closed with zero variance', closeRes.status === 200 && closeRes.body.data.variance === 0);

  /* ------------------------------------------------------------------ *
   * SECTION 10: Reports, Accounting Ledgers & Export Engine
   * ------------------------------------------------------------------ */
  section('SECTION 10: Reports, Accounting Ledgers & Exports');

  // 1. Customer Outstanding Report
  const custReport = await request('GET', '/reports/customers/outstanding');
  check('Customer Outstanding report generated', custReport.body.success === true);
  check('Total customer outstanding matches credit sales (₹800)', custReport.body.data.totalOutstanding === 800, `₹${custReport.body.data.totalOutstanding} receivable`);
  check('Ageing buckets exist', Array.isArray(custReport.body.data.ageing));

  // 2. Vendor Payables Report
  const vendReport = await request('GET', '/reports/vendors/payables');
  check('Vendor Payables report shows remaining ₹1,500 payable', vendReport.body.data.totalPayable === 1500, `₹${vendReport.body.data.totalPayable} payable`);

  // 3. Daily Sales Report
  const salesReport = await request('GET', '/reports/sales/daily');
  check('Daily Sales report generated with day rows', salesReport.body.success === true && Array.isArray(salesReport.body.data.rows));

  // 4. Daily Cash Summary Report
  const cashSummary = await request('GET', '/reports/cash-summary');
  check('Daily Cash Summary report generated', cashSummary.body.success === true);

  // 5. Accounting: Chart of Accounts & Tree
  const coa = await request('GET', '/accounts/chart');
  check('Chart of Accounts loaded', coa.status === 200 && Array.isArray(coa.body.data?.flat));

  // 6. Test Exporters (Excel, CSV, PDF formatted structures)
  for (const reportKey of ['sales-daily', 'stock', 'customer-outstanding', 'vendor-payables', 'expenses', 'cash-summary']) {
    const exp = await request('GET', `/reports/export/${reportKey}`);
    check(`Export structure for "${reportKey}" generated`, exp.body.success === true && Array.isArray(exp.body.data.rows));
  }

  // 6. Test Exporters (Excel, CSV, PDF formatted structures)
  for (const reportKey of ['sales-daily', 'stock', 'customer-outstanding', 'vendor-payables', 'expenses', 'cash-summary']) {
    const exp = await request('GET', `/reports/export/${reportKey}`);
    check(`Export structure for "${reportKey}" generated`, exp.body.success === true && Array.isArray(exp.body.data.rows));
  }

  /* ------------------------------------------------------------------ *
   * SUMMARY
   * ------------------------------------------------------------------ */
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  COMPREHENSIVE TEST RESULTS: ${passedChecks} PASSED · ${failedChecks.length} FAILED`);
  console.log(`════════════════════════════════════════════════════════════════`);

  if (failedChecks.length > 0) {
    console.log('Failed checks:');
    failedChecks.forEach((f) => console.log(`  ❌ ${f.label} (${f.detail})`));
  }

  // Cleanup
  if (server) server.close();
  await mongoose.connection.useDb(TENANT.dbName, { useCache: true }).db.dropDatabase().catch(() => {});
  await models.Tenant.deleteOne({ id: TENANT.id });
  await mongoose.disconnect();

  if (failedChecks.length === 0) {
    console.log('\n🎉 ALL SECTIONS AND FEATURES TESTED & VERIFIED 100% OPERATIONAL!\n');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  if (server) server.close();
  process.exit(1);
});
