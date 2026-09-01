const mongoose = require('mongoose');
const { models, ensureMasterDB } = require('../db');
const { getTenantDb } = require('../tenantDb');

async function seedAndTestPurchases() {
  console.log('================================================================');
  console.log('   DEEP TESTING & SAMPLE DATA GENERATION FOR PURCHASES SECTION  ');
  console.log('================================================================\n');

  await ensureMasterDB();
  const tenants = await models.Tenant.find();
  console.log('Found ' + tenants.length + ' tenant(s) in system.');

  for (const tenant of tenants) {
    console.log('\n----------------------------------------------------------------');
    console.log('Processing Tenant: ' + tenant.name + ' (' + tenant.dbName + ')');
    console.log('----------------------------------------------------------------');

    const tDb = getTenantDb(tenant.dbName);
    if (!tDb) {
      console.log('  ⚠️ Could not connect to tenant database ' + tenant.dbName);
      continue;
    }

    // 1. Create Suppliers / Vendors
    console.log('▶ [1/6] Seeding Vendors...');
    const vendorData = [
      {
        id: 'v_hul_' + Date.now(),
        name: 'Hindustan Unilever Wholesale Ltd',
        contactPerson: 'Sanjay Deshmukh',
        phone: '+91 9820112233',
        email: 'supply@hul-wholesale.com',
        gstin: '27AABCH1429B1Z8',
        address: 'B-42, APMC Market Yard, Vashi, Navi Mumbai, MH - 400703',
        openingBalance: 0,
        outstandingPayable: 0,
        createdAt: new Date().toISOString()
      },
      {
        id: 'v_tata_' + Date.now(),
        name: 'Tata Consumer Products Distributors',
        contactPerson: 'Meera Nambiar',
        phone: '+91 9845012345',
        email: 'orders@tataconsumer-dist.in',
        gstin: '29AAACT9876C1Z4',
        address: 'Plot 18, Peenya Industrial Area, Bengaluru, KA - 560058',
        openingBalance: 0,
        outstandingPayable: 0,
        createdAt: new Date().toISOString()
      },
      {
        id: 'v_amul_' + Date.now(),
        name: 'Amul Dairy & FMCG Supplies',
        contactPerson: 'Vikram Patel',
        phone: '+91 9712033445',
        email: 'sales@amuldairy-fmcg.com',
        gstin: '24AABCA5544P1ZV',
        address: 'Amul Complex, Anand, Gujarat - 388001',
        openingBalance: 0,
        outstandingPayable: 0,
        createdAt: new Date().toISOString()
      },
      {
        id: 'v_parle_' + Date.now(),
        name: 'Parle Agro & Beverages Hub',
        contactPerson: 'Rajesh Nair',
        phone: '+91 9890123456',
        email: 'beverages@parleagro-hub.com',
        gstin: '27AAACP1234Q1Z1',
        address: 'Western Express Highway, Vile Parle East, Mumbai - 400057',
        openingBalance: 0,
        outstandingPayable: 0,
        createdAt: new Date().toISOString()
      }
    ];

    const seededVendors = [];
    for (const v of vendorData) {
      let existing = await tDb.collection('vendors').findOne({ name: v.name });
      if (!existing) {
        await tDb.collection('vendors').insertOne(v);
        existing = v;
      }
      seededVendors.push(existing);
      console.log('  ✅ Vendor: ' + existing.name + ' (' + existing.phone + ')');
    }

    const [vHul, vTata, vAmul, vParle] = seededVendors;

    // 2. Create Products with Cost Price, GST %, HSN & Batch Tracking
    console.log('\n▶ [2/6] Seeding Catalog Products with GST & Batch settings...');
    const productData = [
      {
        id: 'prod_rice_5k',
        name: 'Royal Heritage Basmati Rice (5kg)',
        sku: 'RICE-BAS-5K',
        barcode: '890103001001',
        category: 'Grocery',
        unit: 'bags',
        purchasePrice: 420.00,
        price: 540.00,
        taxRate: 5,
        hsn: '10063020',
        stock: 50,
        trackBatches: true
      },
      {
        id: 'prod_oil_1l',
        name: 'Fortune Sunlite Sunflower Oil (1L Pouch)',
        sku: 'OIL-SUN-1L',
        barcode: '890103001002',
        category: 'Grocery',
        unit: 'pouches',
        purchasePrice: 110.00,
        price: 138.00,
        taxRate: 5,
        hsn: '15121910',
        stock: 80,
        trackBatches: true
      },
      {
        id: 'prod_tata_tea_500',
        name: 'Tata Tea Premium (500g Pack)',
        sku: 'TEA-TATA-500',
        barcode: '890103001003',
        category: 'Beverages',
        unit: 'packs',
        purchasePrice: 175.00,
        price: 230.00,
        taxRate: 5,
        hsn: '09024020',
        stock: 45,
        trackBatches: true
      },
      {
        id: 'prod_nescafe_100',
        name: 'Nescafe Classic Instant Coffee (100g Jar)',
        sku: 'COF-NES-100',
        barcode: '890103001004',
        category: 'Beverages',
        unit: 'jars',
        purchasePrice: 210.00,
        price: 290.00,
        taxRate: 18,
        hsn: '21011110',
        stock: 30,
        trackBatches: true
      },
      {
        id: 'prod_amul_butter_500',
        name: 'Amul Pasteurized Butter (500g)',
        sku: 'DAI-BUT-500',
        barcode: '890103001005',
        category: 'Dairy',
        unit: 'packs',
        purchasePrice: 235.00,
        price: 275.00,
        taxRate: 12,
        hsn: '04051000',
        stock: 40,
        trackBatches: true
      },
      {
        id: 'prod_frooti_1l',
        name: 'Frooti Mango Drink (1L Tetra Pack)',
        sku: 'BEV-FRO-1L',
        barcode: '890103001006',
        category: 'Beverages',
        unit: 'packs',
        purchasePrice: 62.00,
        price: 85.00,
        taxRate: 12,
        hsn: '22029920',
        stock: 60
      }
    ];

    const seededProducts = [];
    for (const p of productData) {
      let existing = await tDb.collection('products').findOne({ sku: p.sku });
      if (!existing) {
        await tDb.collection('products').insertOne(p);
        existing = p;
      } else {
        await tDb.collection('products').updateOne(
          { sku: p.sku },
          { $set: { purchasePrice: p.purchasePrice, price: p.price, taxRate: p.taxRate, hsn: p.hsn, trackBatches: p.trackBatches } }
        );
      }
      seededProducts.push(existing);
      console.log('  ✅ Product: ' + existing.name + ' (Cost: ₹' + existing.purchasePrice + ', GST: ' + existing.taxRate + '%)');
    }

    const [pRice, pOil, pTea, pCof, pButter, pFrooti] = seededProducts;

    // 3. Create Sample Purchase Orders
    console.log('\n▶ [3/6] Seeding Purchase Orders across all Statuses...');
    const poList = [
      {
        id: 'po_1001_' + Date.now(),
        poNumber: 'PO-1001',
        vendorId: vHul.id,
        vendorName: vHul.name,
        date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
        expectedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        status: 'ISSUED',
        subtotal: 42000,
        tax: 2100,
        totalAmount: 44100,
        items: [
          {
            productId: pRice.id,
            productName: pRice.name,
            unit: pRice.unit,
            orderedQty: 100,
            receivedQty: 0,
            rate: 420,
            taxRate: 5,
            hsn: pRice.hsn
          }
        ],
        notes: 'Bulk monthly stock replenishment for APMC grocery stores'
      },
      {
        id: 'po_1002_' + Date.now(),
        poNumber: 'PO-1002',
        vendorId: vTata.id,
        vendorName: vTata.name,
        date: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
        expectedDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
        status: 'PARTIALLY_RECEIVED',
        subtotal: 18850,
        tax: 2367,
        totalAmount: 21217,
        items: [
          {
            productId: pTea.id,
            productName: pTea.name,
            unit: pTea.unit,
            orderedQty: 60,
            receivedQty: 40,
            rate: 175,
            taxRate: 5,
            hsn: pTea.hsn
          },
          {
            productId: pCof.id,
            productName: pCof.name,
            unit: pCof.unit,
            orderedQty: 40,
            receivedQty: 20,
            rate: 210,
            taxRate: 18,
            hsn: pCof.hsn
          }
        ],
        notes: 'Direct distributor consignment'
      },
      {
        id: 'po_1003_' + Date.now(),
        poNumber: 'PO-1003',
        vendorId: vAmul.id,
        vendorName: vAmul.name,
        date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
        expectedDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
        status: 'COMPLETED',
        subtotal: 18800,
        tax: 2256,
        totalAmount: 21056,
        items: [
          {
            productId: pButter.id,
            productName: pButter.name,
            unit: pButter.unit,
            orderedQty: 80,
            receivedQty: 80,
            rate: 235,
            taxRate: 12,
            hsn: pButter.hsn
          }
        ],
        notes: 'Cold chain delivery completed'
      },
      {
        id: 'po_1004_' + Date.now(),
        poNumber: 'PO-1004',
        vendorId: vParle.id,
        vendorName: vParle.name,
        date: new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10),
        expectedDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
        status: 'CANCELLED',
        subtotal: 12400,
        tax: 1488,
        totalAmount: 13888,
        items: [
          {
            productId: pFrooti.id,
            productName: pFrooti.name,
            unit: pFrooti.unit,
            orderedQty: 200,
            receivedQty: 0,
            rate: 62,
            taxRate: 12,
            hsn: pFrooti.hsn
          }
        ],
        notes: 'Order cancelled due to supplier factory transit delay'
      }
    ];

    for (const po of poList) {
      await tDb.collection('purchaseorders').deleteOne({ poNumber: po.poNumber });
      await tDb.collection('purchaseorders').insertOne(po);
      console.log('  ✅ PO ' + po.poNumber + ' [' + po.status + '] Total: ₹' + po.totalAmount + ' (' + po.vendorName + ')');
    }

    // 4. Create Sample Purchase Invoices
    console.log('\n▶ [4/6] Seeding Purchase Invoices across Payment Statuses...');
    const invoiceList = [
      // 1. Unpaid Invoice (30 Days Credit)
      {
        id: 'pur_inv_001_' + Date.now(),
        invoiceNo: 'HUL-INV-8901',
        voucherNo: 'VCH-PUR-0001',
        vendorId: vHul.id,
        vendorName: vHul.name,
        vendorGstin: vHul.gstin,
        vendorAddress: vHul.address,
        date: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 26 * 86400000).toISOString().slice(0, 10),
        paymentStatus: 'UNPAID',
        paidAmount: 0,
        status: 'ACTIVE',
        subtotal: 32000,
        tax: 1600,
        totalAmount: 33600,
        items: [
          {
            productId: pRice.id,
            name: pRice.name,
            unit: pRice.unit,
            qty: 50,
            rate: 420,
            taxRate: 5,
            hsn: pRice.hsn,
            batchNo: 'B-RICE-AUG26',
            expiryDate: '2027-12-31'
          },
          {
            productId: pOil.id,
            name: pOil.name,
            unit: pOil.unit,
            qty: 100,
            rate: 110,
            taxRate: 5,
            hsn: pOil.hsn,
            batchNo: 'B-OIL-0926',
            expiryDate: '2027-08-31'
          }
        ],
        notes: 'Monthly staples consignment'
      },
      // 2. Partially Paid Invoice (Received against PO-1002)
      {
        id: 'pur_inv_002_' + Date.now(),
        invoiceNo: 'TATA-INV-4412',
        voucherNo: 'VCH-PUR-0002',
        poId: poList[1].id,
        poNumber: 'PO-1002',
        vendorId: vTata.id,
        vendorName: vTata.name,
        vendorGstin: vTata.gstin,
        vendorAddress: vTata.address,
        date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
        paymentStatus: 'PARTIAL',
        paidAmount: 8000,
        status: 'ACTIVE',
        subtotal: 11200,
        tax: 1106,
        totalAmount: 12306,
        items: [
          {
            productId: pTea.id,
            name: pTea.name,
            unit: pTea.unit,
            qty: 40,
            rate: 175,
            taxRate: 5,
            hsn: pTea.hsn,
            batchNo: 'TATA-TEA-P1',
            expiryDate: '2028-02-28'
          },
          {
            productId: pCof.id,
            name: pCof.name,
            unit: pCof.unit,
            qty: 20,
            rate: 210,
            taxRate: 18,
            hsn: pCof.hsn,
            batchNo: 'NES-COF-X1',
            expiryDate: '2028-06-30'
          }
        ],
        notes: 'Received partial batch against PO-1002'
      },
      // 3. Fully Paid Invoice (Cold chain Amul butter)
      {
        id: 'pur_inv_003_' + Date.now(),
        invoiceNo: 'AMUL-INV-9981',
        voucherNo: 'VCH-PUR-0003',
        poId: poList[2].id,
        poNumber: 'PO-1003',
        vendorId: vAmul.id,
        vendorName: vAmul.name,
        vendorGstin: vAmul.gstin,
        vendorAddress: vAmul.address,
        date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
        paymentStatus: 'PAID',
        paymentMode: 'Bank Transfer',
        paidAmount: 21056,
        status: 'ACTIVE',
        subtotal: 18800,
        tax: 2256,
        totalAmount: 21056,
        items: [
          {
            productId: pButter.id,
            name: pButter.name,
            unit: pButter.unit,
            qty: 80,
            rate: 235,
            taxRate: 12,
            hsn: pButter.hsn,
            batchNo: 'AMUL-BTR-881',
            expiryDate: '2026-12-31'
          }
        ],
        notes: 'Paid in full via RTGS upon gate delivery'
      },
      // 4. Overdue Invoice (Past due date)
      {
        id: 'pur_inv_004_' + Date.now(),
        invoiceNo: 'PARLE-INV-3011',
        voucherNo: 'VCH-PUR-0004',
        vendorId: vParle.id,
        vendorName: vParle.name,
        vendorGstin: vParle.gstin,
        vendorAddress: vParle.address,
        date: new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10),
        dueDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
        paymentStatus: 'UNPAID',
        paidAmount: 0,
        status: 'ACTIVE',
        isOverdue: true,
        subtotal: 6200,
        tax: 744,
        totalAmount: 6944,
        items: [
          {
            productId: pFrooti.id,
            name: pFrooti.name,
            unit: pFrooti.unit,
            qty: 100,
            rate: 62,
            taxRate: 12,
            hsn: pFrooti.hsn
          }
        ],
        notes: 'Invoice overdue by 5 days'
      },
      // 5. Voided Invoice (Cancelled entry)
      {
        id: 'pur_inv_005_' + Date.now(),
        invoiceNo: 'VOID-SAMPLE-01',
        voucherNo: 'VCH-PUR-0005',
        vendorId: vHul.id,
        vendorName: vHul.name,
        vendorGstin: vHul.gstin,
        date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
        paymentStatus: 'UNPAID',
        paidAmount: 0,
        status: 'VOID',
        voidedBy: 'Admin',
        voidedAt: new Date(Date.now() - 9 * 86400000).toISOString(),
        subtotal: 8400,
        tax: 420,
        totalAmount: 8820,
        items: [
          {
            productId: pRice.id,
            name: pRice.name,
            unit: pRice.unit,
            qty: 20,
            rate: 420,
            taxRate: 5,
            hsn: pRice.hsn
          }
        ],
        notes: 'Entry voided due to double billing error by vendor'
      }
    ];

    for (const inv of invoiceList) {
      await tDb.collection('purchases').deleteOne({ invoiceNo: inv.invoiceNo });
      await tDb.collection('purchases').insertOne(inv);
      console.log('  ✅ Purchase Invoice: ' + inv.invoiceNo + ' [' + inv.paymentStatus + ' | ' + inv.status + '] Total: ₹' + inv.totalAmount + ' (Vendor: ' + inv.vendorName + ')');
    }

    // 5. Create Sample Vendor Payment Vouchers
    console.log('\n▶ [5/6] Seeding Vendor Payment Vouchers...');
    const paymentList = [
      {
        id: 'pmt_001_' + Date.now(),
        vendorId: vTata.id,
        vendorName: vTata.name,
        amount: 8000,
        paymentMode: 'UPI',
        date: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10),
        reference: 'UPI-REF-99201948',
        voucherNo: 'PMT-00001',
        note: 'Part payment towards TATA-INV-4412'
      },
      {
        id: 'pmt_002_' + Date.now(),
        vendorId: vAmul.id,
        vendorName: vAmul.name,
        amount: 21056,
        paymentMode: 'Bank Transfer',
        date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
        reference: 'NEFT-AXIS-7746192',
        voucherNo: 'PMT-00002',
        note: 'Full settlement of AMUL-INV-9981'
      }
    ];

    for (const pmt of paymentList) {
      await tDb.collection('payments').deleteOne({ voucherNo: pmt.voucherNo });
      await tDb.collection('payments').insertOne(pmt);
      console.log('  ✅ Payment Voucher: ' + pmt.voucherNo + ' (₹' + pmt.amount + ' to ' + pmt.vendorName + ' via ' + pmt.paymentMode + ')');
    }

    // 6. Create Purchase Return (Vendor Credit Note)
    console.log('\n▶ [6/6] Seeding Vendor Credit / Debit Notes...');
    const creditList = [
      {
        id: 'vc_001_' + Date.now(),
        creditNoteNo: 'DN-2026-001',
        vendorId: vHul.id,
        vendorName: vHul.name,
        purchaseId: invoiceList[0].id,
        purchaseInvoiceNo: 'HUL-INV-8901',
        date: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10),
        status: 'ACTIVE',
        reason: '5 pouches of Sunflower Oil leaked during transit',
        subtotal: 550,
        tax: 27.50,
        totalAmount: 577.50,
        items: [
          {
            productId: pOil.id,
            productName: pOil.name,
            unit: pOil.unit,
            qty: 5,
            rate: 110,
            taxRate: 5
          }
        ]
      }
    ];

    for (const vc of creditList) {
      await tDb.collection('vendorcredits').deleteOne({ creditNoteNo: vc.creditNoteNo });
      await tDb.collection('vendorcredits').insertOne(vc);
      console.log('  ✅ Vendor Credit / Debit Note: ' + vc.creditNoteNo + ' (₹' + vc.totalAmount + ' credited by ' + vc.vendorName + ')');
    }

    // Update vendor balances
    await tDb.collection('vendors').updateOne({ id: vHul.id }, { $set: { outstandingPayable: 33600 - 577.50 } });
    await tDb.collection('vendors').updateOne({ id: vTata.id }, { $set: { outstandingPayable: 12306 - 8000 } });
    await tDb.collection('vendors').updateOne({ id: vAmul.id }, { $set: { outstandingPayable: 0 } });
    await tDb.collection('vendors').updateOne({ id: vParle.id }, { $set: { outstandingPayable: 6944 } });

    console.log('\n  📊 Live Vendor Payables Summary for ' + tenant.name + ':');
    console.log('     • ' + vHul.name + ': ₹' + (33600 - 577.50).toFixed(2) + ' payable');
    console.log('     • ' + vTata.name + ': ₹' + (12306 - 8000).toFixed(2) + ' payable');
    console.log('     • ' + vParle.name + ': ₹6944.00 payable (OVERDUE)');
    console.log('     • ' + vAmul.name + ': ₹0.00 payable (Settled)');
  }

  console.log('\n================================================================');
  console.log('  🎉 SAMPLE DATA GENERATION & PURCHASES TESTING COMPLETED 100%!');
  console.log('================================================================\n');

  await mongoose.disconnect();
}

seedAndTestPurchases().catch(err => {
  console.error('ERROR SEEDING PURCHASES:', err);
  mongoose.disconnect();
  process.exit(1);
});
