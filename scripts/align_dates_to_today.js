const mongoose = require('mongoose');
const { models, ensureMasterDB } = require('../db');
const { getTenantDb } = require('../tenantDb');

async function updateDatesToToday() {
  await ensureMasterDB();
  const tenants = await models.Tenant.find();

  const today = new Date().toISOString().slice(0, 10);
  console.log('Today ISO Date:', today);

  for (const tenant of tenants) {
    const tDb = getTenantDb(tenant.dbName);
    if (!tDb) continue;

    console.log('Updating dates in tenant:', tenant.name);

    // Update all purchase invoices to today
    await tDb.collection('purchases').updateMany(
      { invoiceNo: { $in: ['HUL-INV-8901', 'TATA-INV-4412', 'AMUL-INV-9981', 'PARLE-INV-3011', 'VOID-SAMPLE-01'] } },
      { $set: { date: today } }
    );

    // Update all POs to today
    await tDb.collection('purchaseorders').updateMany(
      { poNumber: { $in: ['PO-1001', 'PO-1002', 'PO-1003', 'PO-1004'] } },
      { $set: { date: today } }
    );

    // Update all payments to today
    await tDb.collection('payments').updateMany(
      { voucherNo: { $in: ['PMT-00001', 'PMT-00002'] } },
      { $set: { date: today } }
    );

    // Update returns to today
    await tDb.collection('vendorcredits').updateMany(
      { creditNoteNo: 'DN-2026-001' },
      { $set: { date: today } }
    );

    // Also seed 3 prominent Sales Invoices with today's date for Invoices tab!
    const salesInvoices = [
      {
        orderId: 'INV-2026-9001',
        invoiceNo: 'INV-2026-9001',
        customerName: 'Aarav Sharma (Wholesale Mart)',
        customerPhone: '+91 9820551122',
        customerGstin: '27AABCS1429B1Z8',
        customerAddress: '402, High Street, Bandra West, Mumbai',
        date: today,
        paymentMethod: 'UPI',
        status: 'PAID',
        subtotal: 12500,
        tax: 625,
        total: 13125,
        items: [
          {
            name: 'Royal Heritage Basmati Rice (5kg)',
            qty: 20,
            price: 540,
            taxRate: 5,
            hsn: '10063020',
            total: 10800
          },
          {
            name: 'Tata Tea Premium (500g Pack)',
            qty: 10,
            price: 230,
            taxRate: 5,
            hsn: '09024020',
            total: 2300
          }
        ]
      },
      {
        orderId: 'INV-2026-9002',
        invoiceNo: 'INV-2026-9002',
        customerName: 'Priya Patel (Patel Caterers)',
        customerPhone: '+91 9833099881',
        customerGstin: '27AAACP9988Q1Z1',
        customerAddress: 'Shop 12, APMC Market, Vashi, Navi Mumbai',
        date: today,
        paymentMethod: 'Credit (Udhar)',
        status: 'UNPAID',
        dueDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
        subtotal: 8250,
        tax: 990,
        total: 9240,
        items: [
          {
            name: 'Fortune Sunlite Sunflower Oil (1L Pouch)',
            qty: 50,
            price: 138,
            taxRate: 5,
            hsn: '15121910',
            total: 6900
          },
          {
            name: 'Frooti Mango Drink (1L Tetra Pack)',
            qty: 25,
            price: 85,
            taxRate: 12,
            hsn: '22029920',
            total: 2125
          }
        ]
      }
    ];

    for (const inv of salesInvoices) {
      await tDb.collection('sales').deleteOne({ orderId: inv.orderId });
      await tDb.collection('sales').insertOne(inv);
      console.log('  ✅ Seeded Sales Invoice: ' + inv.orderId + ' for ' + inv.customerName + ' (₹' + inv.total + ')');
    }
  }

  console.log('\nAll dates aligned to today and sales invoices seeded successfully!');
  await mongoose.disconnect();
}

updateDatesToToday();
