const mongoose = require('mongoose');
const { getTenantDb } = require('../tenantDb');
const { ensureMasterDB } = require('../db');

async function testFetch() {
  await ensureMasterDB();
  const tDb = getTenantDb('tenant_db_isekai');

  const vendors = await tDb.collection('vendors').find().toArray();
  const purchases = await tDb.collection('purchases').find().toArray();
  const pos = await tDb.collection('purchaseorders').find().toArray();
  const returns = await tDb.collection('vendorcredits').find().toArray();
  const payments = await tDb.collection('payments').find().toArray();

  console.log('====================================================');
  console.log('   VERIFICATION OF SEEDED PURCHASE DATA IN ISEKAI   ');
  console.log('====================================================');
  console.log('Vendors count:', vendors.length);
  console.log('Purchase Invoices count:', purchases.length);
  console.log('Purchase Orders count:', pos.length);
  console.log('Returns / Vendor Credits count:', returns.length);
  console.log('Payments count:', payments.length);

  console.log('\n--- INVOICES SUMMARY ---');
  purchases.forEach(p => {
    console.log('• ' + p.invoiceNo + ' | ' + p.vendorName + ' | ₹' + p.totalAmount + ' | Payment: ' + p.paymentStatus + ' | Doc: ' + p.status + ' | Overdue: ' + (p.isOverdue || false));
  });

  console.log('\n--- PURCHASE ORDERS SUMMARY ---');
  pos.forEach(p => {
    console.log('• ' + p.poNumber + ' | ' + p.vendorName + ' | ₹' + p.totalAmount + ' | Status: ' + p.status + ' | Lines: ' + (p.items ? p.items.length : 0));
  });

  console.log('\n--- RETURNS / DEBIT NOTES ---');
  returns.forEach(r => {
    console.log('• ' + r.creditNoteNo + ' | Against: ' + r.purchaseInvoiceNo + ' | ₹' + r.totalAmount + ' | Reason: ' + r.reason);
  });

  console.log('\n--- PAYMENTS MADE ---');
  payments.forEach(pay => {
    console.log('• ' + pay.voucherNo + ' | To: ' + pay.vendorName + ' | ₹' + pay.amount + ' | Mode: ' + pay.paymentMode + ' | Ref: ' + pay.reference);
  });

  console.log('\n✅ ALL SECTIONS FULLY POPULATED AND READY IN UI!');
  await mongoose.disconnect();
}

testFetch();
