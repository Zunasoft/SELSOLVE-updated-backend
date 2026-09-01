const mongoose = require('mongoose');
const { getTenantDb } = require('../tenantDb');
const { ensureMasterDB } = require('../db');

async function inspectVendorsAndPurchases() {
  await ensureMasterDB();
  const tDb = getTenantDb('tenant_db_isekai');

  const vendors = await tDb.collection('vendors').find().toArray();
  const purchases = await tDb.collection('purchases').find().toArray();

  console.log('--- VENDORS ---');
  vendors.forEach(v => console.log('Vendor:', v.id, '|', v.name, '| Payable:', v.outstandingPayable));

  console.log('\n--- PURCHASES ---');
  purchases.forEach(p => console.log('Purchase:', p.invoiceNo, '| VendorId:', p.vendorId, '| VendorName:', p.vendorName, '| Status:', p.paymentStatus, '| Total:', p.totalAmount, '| Paid:', p.paidAmount));

  await mongoose.disconnect();
}

inspectVendorsAndPurchases();
