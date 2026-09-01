const mongoose = require('mongoose');
const { getTenantDb } = require('../tenantDb');
const { ensureMasterDB } = require('../db');

async function checkInvoices() {
  await ensureMasterDB();
  const tDb = getTenantDb('tenant_db_isekai');

  const orders = await tDb.collection('sales').find().toArray();
  const quotations = await tDb.collection('quotations').find().toArray();

  console.log('Orders (Sales Invoices) count in isekai:', orders.length);
  console.log('Quotations count in isekai:', quotations.length);
  orders.forEach(o => console.log('• Sale Invoice: ' + (o.orderId || o.id) + ' | Customer: ' + (o.customerName || 'Walk-in') + ' | ₹' + o.total + ' | Payment: ' + o.paymentMethod + ' | Status: ' + (o.status || 'PAID')));
  quotations.forEach(q => console.log('• Quotation: ' + (q.quotationNo || q.id) + ' | Customer: ' + q.customerName + ' | ₹' + q.total));

  await mongoose.disconnect();
}

checkInvoices();
