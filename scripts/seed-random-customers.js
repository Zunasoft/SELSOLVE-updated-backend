/**
 * Script to seed 10 realistic Indian customer profiles into tenant databases.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const CUSTOMERS_LIST = [
  {
    id: 'cust_aarav_sharma',
    name: 'Aarav Sharma',
    phone: '9820112345',
    email: 'aarav.sharma@gmail.com',
    group: 'Retail',
    address: 'Flat 402, Green Glen Heights, Bellandur, Bengaluru, Karnataka 560103',
    gstin: '29ABCDE1234F1Z5',
    creditLimit: 15000,
    outstanding: 2450,
    loyaltyPoints: 180,
    discountPercent: 0,
    customPrices: {},
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString()
  },
  {
    id: 'cust_priya_patel',
    name: 'Priya Patel',
    phone: '9879523456',
    email: 'priya.patel@yahoo.co.in',
    group: 'VIP',
    address: 'B-12, Shanti Niketan Society, Navrangpura, Ahmedabad, Gujarat 380009',
    gstin: '',
    creditLimit: 50000,
    outstanding: 0,
    loyaltyPoints: 420,
    discountPercent: 5,
    priceSheetId: 'ps_vip',
    createdAt: new Date(Date.now() - 25 * 86400000).toISOString()
  },
  {
    id: 'cust_rajesh_gupta',
    name: 'Rajesh Gupta (Gupta General Stores)',
    phone: '9811034567',
    email: 'guptastores.delhi@gmail.com',
    group: 'Wholesale',
    address: 'Shop No. 14, Sadar Bazar Wholesale Market, Old Delhi 110006',
    gstin: '07AAACG1234D1Z2',
    creditLimit: 150000,
    outstanding: 18600,
    loyaltyPoints: 95,
    discountPercent: 0,
    priceSheetId: 'ps_wholesale',
    createdAt: new Date(Date.now() - 20 * 86400000).toISOString()
  },
  {
    id: 'cust_sneha_reddy',
    name: 'Sneha Reddy',
    phone: '9949045678',
    email: 'sneha.reddy92@outlook.com',
    group: 'Retail',
    address: 'Plot 58, Road No. 10, Jubilee Hills, Hyderabad, Telangana 500033',
    gstin: '',
    creditLimit: 10000,
    outstanding: 0,
    loyaltyPoints: 260,
    discountPercent: 0,
    createdAt: new Date(Date.now() - 18 * 86400000).toISOString()
  },
  {
    id: 'cust_vikram_rao',
    name: 'Vikramaditya Rao (V. Rao & Sons)',
    phone: '9845056789',
    email: 'rao.enterprises@rediffmail.com',
    group: 'Wholesale',
    address: 'Warehouse 7, APMC Yard, Yeshwanthpur, Bengaluru, Karnataka 560022',
    gstin: '29AAACV5678K1Z9',
    creditLimit: 200000,
    outstanding: 42500,
    loyaltyPoints: 150,
    discountPercent: 0,
    priceSheetId: 'ps_wholesale',
    createdAt: new Date(Date.now() - 15 * 86400000).toISOString()
  },
  {
    id: 'cust_ananya_deshmukh',
    name: 'Ananya Deshmukh',
    phone: '9822067890',
    email: 'ananya.deshmukh@gmail.com',
    group: 'VIP',
    address: 'Row House 4, Orchid Enclave, Kalyani Nagar, Pune, Maharashtra 411006',
    gstin: '',
    creditLimit: 30000,
    outstanding: 1200,
    loyaltyPoints: 510,
    discountPercent: 5,
    priceSheetId: 'ps_vip',
    createdAt: new Date(Date.now() - 12 * 86400000).toISOString()
  },
  {
    id: 'cust_mohammed_zaid',
    name: 'Mohammed Zaid (Al-Madina Caterers)',
    phone: '9848078901',
    email: 'zaid.caterers@gmail.com',
    group: 'Wholesale',
    address: '21-4-108, Near Charminar, Old City, Hyderabad, Telangana 500002',
    gstin: '36ABUPZ9876Q1Z3',
    creditLimit: 80000,
    outstanding: 8900,
    loyaltyPoints: 340,
    discountPercent: 0,
    priceSheetId: 'ps_wholesale',
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString()
  },
  {
    id: 'cust_kavita_sundaram',
    name: 'Kavita Sundaram',
    phone: '9840089012',
    email: 'kavita.sundaram@gmail.com',
    group: 'Retail',
    address: '15/4, 2nd Main Road, Gandhi Nagar, Adyar, Chennai, Tamil Nadu 600020',
    gstin: '',
    creditLimit: 5000,
    outstanding: 650,
    loyaltyPoints: 110,
    discountPercent: 0,
    createdAt: new Date(Date.now() - 8 * 86400000).toISOString()
  },
  {
    id: 'cust_amitabh_mukherjee',
    name: 'Amitabh Mukherjee (Mukherjee Tech Solutions)',
    phone: '9830090123',
    email: 'amitabh.mukherjee@tcs.com',
    group: 'Retail',
    address: 'Flat 6B, Tower 2, South City Complex, Prince Anwar Shah Road, Kolkata, West Bengal 700068',
    gstin: '19AAECM4321P1Z7',
    creditLimit: 40000,
    outstanding: 0,
    loyaltyPoints: 300,
    discountPercent: 0,
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString()
  },
  {
    id: 'cust_meenakshi_iyer',
    name: 'Meenakshi Iyer',
    phone: '9819001234',
    email: 'meenakshi.iyer@gmail.com',
    group: 'Staff',
    address: 'B-303, Palm Grove, Hiranandani Gardens, Powai, Mumbai, Maharashtra 400076',
    gstin: '',
    creditLimit: 20000,
    outstanding: 0,
    loyaltyPoints: 75,
    discountPercent: 10,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString()
  }
];

(async () => {
  const mongoUri = process.env.ADMIN_BE_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/selsolve';
  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  const master = mongoose.connection.db;

  const tenants = await master.collection('tenants').find({}).toArray();
  console.log(`Found ${tenants.length} tenants registered in master.`);

  // Find all tenant databases
  const adminDb = mongoose.connection.useDb('admin', { useCache: true }).db;
  const dbsList = await adminDb.admin().listDatabases();
  const tenantDbNames = dbsList.databases
    .map(d => d.name)
    .filter(name => name.startsWith('tenant_db_') || tenants.some(t => t.dbName === name));

  console.log(`Tenant databases to seed:`, tenantDbNames);

  for (const dbName of tenantDbNames) {
    console.log(`\nSeeding customers into ${dbName}...`);
    const db = mongoose.connection.useDb(dbName, { useCache: true }).db;
    
    for (const cust of CUSTOMERS_LIST) {
      await db.collection('customers').updateOne(
        { id: cust.id },
        { $set: cust },
        { upsert: true }
      );
      // Also ensure in parties collection if present
      await db.collection('parties').updateOne(
        { id: cust.id },
        { $set: { ...cust, type: 'customer' } },
        { upsert: true }
      ).catch(() => {});
    }

    const count = await db.collection('customers').countDocuments();
    console.log(`✓ ${dbName} now has ${count} customer records.`);
  }

  console.log('\n✅ 10 Customers successfully created and seeded!');
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
