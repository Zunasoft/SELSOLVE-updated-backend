const mongoose = require('mongoose');
const { getTenantDb, hydrateTenantStore, persistTenantStore } = require('../tenantDb');
const { ensureMasterDB, models } = require('../db');
const posting = require('../accounting/posting');
const engine = require('../accounting/engine');

async function testPaymentSettlement() {
  await ensureMasterDB();
  const tenant = await models.Tenant.findOne({ dbName: 'tenant_db_isekai' });
  const store = {};
  await hydrateTenantStore('tenant_db_isekai', store, tenant, true);

  console.log('--- BEFORE PAYMENT ---');
  const targetVendor = (store.vendors || []).find(v => v.name.includes('Tata'));
  console.log('Vendor:', targetVendor.name, '| Payable:', targetVendor.outstandingPayable);

  const vendorPurchasesBefore = (store.purchases || []).filter(p => p.vendorId === targetVendor.id || p.vendorName === targetVendor.name);
  vendorPurchasesBefore.forEach(p => console.log('  • Invoice:', p.invoiceNo, '| Total:', p.totalAmount, '| Paid:', p.paidAmount, '| Status:', p.paymentStatus));

  // Settle the remaining ₹4,306 on Tata
  console.log('\n--- SIMULATING PAYMENT OF ₹4306 TO TATA ---');
  const payRecord = {
    id: 'pay_test_' + Date.now(),
    vendorId: targetVendor.id,
    vendorName: targetVendor.name,
    amount: 4306,
    discount: 0,
    paymentMode: 'UPI',
    reference: 'UPI-TEST-SETTLE',
    notes: 'Settling remaining balance',
    date: new Date().toISOString()
  };

  const voucher = posting.postPayment(store, payRecord, { vendor: targetVendor, createdBy: 'Tester' });
  payRecord.voucherId = voucher.id;
  payRecord.voucherNo = voucher.voucherNo;
  store.payments.unshift(payRecord);

  const settled = posting.applyVendorPaymentToPurchases(store, targetVendor, payRecord.amount, 0);
  console.log('Settled details:', settled);

  const account = (store.accounts || []).find(a => a.partyId === targetVendor.id && a.partyType === 'VENDOR');
  if (account) {
    targetVendor.outstandingPayable = Math.max(0, engine.accountBalance(store, account.id));
  } else {
    targetVendor.outstandingPayable = 0;
  }

  await persistTenantStore('tenant_db_isekai', store);

  console.log('\n--- AFTER PAYMENT PERSISTENCE ---');
  console.log('Vendor:', targetVendor.name, '| Payable:', targetVendor.outstandingPayable);
  const vendorPurchasesAfter = (store.purchases || []).filter(p => p.vendorId === targetVendor.id || p.vendorName === targetVendor.name);
  vendorPurchasesAfter.forEach(p => console.log('  • Invoice:', p.invoiceNo, '| Total:', p.totalAmount, '| Paid:', p.paidAmount, '| Status:', p.paymentStatus));

  await mongoose.disconnect();
}

testPaymentSettlement();
