/**
 * Script to seed sample vendors into all tenant databases.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const SAMPLE_VENDORS = [
  {
    id: 'ven_sri_lakshmi',
    name: 'Sri Lakshmi Agro Traders',
    phone: '9845112233',
    email: 'orders@srilakshmiagro.com',
    gstin: '29AAAFS1234E1Z8',
    address: 'APMC Yard, Yard No. 42, Yeshwanthpur, Bengaluru, Karnataka 560022',
    outstandingPayable: 45000,
    outstanding: 45000,
    category: 'Grains & Spices',
    createdAt: new Date(Date.now() - 40 * 86400000).toISOString()
  },
  {
    id: 'ven_amul_dairy',
    name: 'Amul Dairy & Milk Distributors',
    phone: '9820223344',
    email: 'distribution.mumbai@amul.coop',
    gstin: '27AAACA1122D1Z4',
    address: 'Plot 18, MIDC Industrial Area, Andheri East, Mumbai, Maharashtra 400093',
    outstandingPayable: 18500,
    outstanding: 18500,
    category: 'Dairy & Cold Chain',
    createdAt: new Date(Date.now() - 35 * 86400000).toISOString()
  },
  {
    id: 'ven_hindustan_fmcg',
    name: 'Hindustan FMCG Supplies',
    phone: '9811334455',
    email: 'sales@hindustanfmcg.in',
    gstin: '07AAACH5566G1Z9',
    address: 'Sadar Bazar Wholesale Complex, Chandni Chowk, Delhi 110006',
    outstandingPayable: 72000,
    outstanding: 72000,
    category: 'FMCG & Toiletries',
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString()
  },
  {
    id: 'ven_royal_beverages',
    name: 'Royal Beverages & Soft Drinks Co.',
    phone: '9949445566',
    email: 'supply@royalbeverages.com',
    gstin: '36AAACR7788K1Z2',
    address: 'Balanagar Industrial Estate, Hyderabad, Telangana 500037',
    outstandingPayable: 12400,
    outstanding: 12400,
    category: 'Beverages',
    createdAt: new Date(Date.now() - 25 * 86400000).toISOString()
  },
  {
    id: 'ven_prime_packaging',
    name: 'Prime Eco Packaging Solutions',
    phone: '9840556677',
    email: 'contact@primeecopack.com',
    gstin: '33AAACP9900L1Z6',
    address: 'Ambattur Industrial Estate, Chennai, Tamil Nadu 600058',
    outstandingPayable: 8250,
    outstanding: 8250,
    category: 'Packaging Materials',
    createdAt: new Date(Date.now() - 20 * 86400000).toISOString()
  },
  {
    id: 'ven_evergreen_fresh',
    name: 'Evergreen Organic Farm Fresh',
    phone: '9822667788',
    email: 'supply@evergreenfresh.in',
    gstin: '27AAACE3344N1Z1',
    address: 'Market Yard, Gultekdi, Pune, Maharashtra 411037',
    outstandingPayable: 6800,
    outstanding: 6800,
    category: 'Fresh Produce',
    createdAt: new Date(Date.now() - 15 * 86400000).toISOString()
  },
  {
    id: 'ven_national_spices',
    name: 'National Spices & Condiments Mills',
    phone: '9830778899',
    email: 'nationalspiceskolkata@gmail.com',
    gstin: '19AAACN6677M1Z5',
    address: 'Posta Wholesale Market, Kolkata, West Bengal 700007',
    outstandingPayable: 24000,
    outstanding: 24000,
    category: 'Spices & Condiments',
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString()
  },
  {
    id: 'ven_reliable_hardware',
    name: 'Reliable Electronics & Scale Spares',
    phone: '9819889900',
    email: 'support@reliablescalespares.com',
    gstin: '27AAACR8899P1Z7',
    address: 'Lamington Road Electronics Hub, Grant Road, Mumbai, Maharashtra 400007',
    outstandingPayable: 3500,
    outstanding: 3500,
    category: 'Hardware & Spares',
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString()
  }
];

(async () => {
  const mongoUri = process.env.ADMIN_BE_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/selsolve';
  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  const master = mongoose.connection.db;

  const tenants = await master.collection('tenants').find({}).toArray();
  console.log(`Found ${tenants.length} tenants registered in master.`);

  const adminDb = mongoose.connection.useDb('admin', { useCache: true }).db;
  const dbsList = await adminDb.admin().listDatabases();
  const tenantDbNames = dbsList.databases
    .map(d => d.name)
    .filter(name => name.startsWith('tenant_db_') || tenants.some(t => t.dbName === name));

  console.log(`Tenant databases to seed vendors:`, tenantDbNames);

  for (const dbName of tenantDbNames) {
    console.log(`\nSeeding vendors into ${dbName}...`);
    const db = mongoose.connection.useDb(dbName, { useCache: true }).db;
    
    for (const ven of SAMPLE_VENDORS) {
      await db.collection('vendors').updateOne(
        { id: ven.id },
        { $set: ven },
        { upsert: true }
      );
      await db.collection('parties').updateOne(
        { id: ven.id },
        { $set: { ...ven, type: 'vendor' } },
        { upsert: true }
      ).catch(() => {});
    }

    const count = await db.collection('vendors').countDocuments();
    console.log(`✓ ${dbName} now has ${count} vendor records.`);
  }

  console.log('\n✅ Sample vendors successfully created and seeded!');
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
