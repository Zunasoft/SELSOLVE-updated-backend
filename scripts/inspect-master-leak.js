/**
 * Report on tenant data that the old code wrote into the MASTER database.
 *
 * Read-only. Run `cleanup-master-leak.js` afterwards to act on it.
 *   node scripts/inspect-master-leak.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const LEAKED = ['products', 'categories', 'warehouses', 'pricesheets', 'stockmovements', 'sales', 'parties'];

(async () => {
  await mongoose.connect(process.env.ADMIN_BE_URL || process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const master = mongoose.connection.db;

  const tenants = await master.collection('tenants').find({}).toArray();
  console.log(`\nTenants registered in master: ${tenants.length}`);
  tenants.forEach((t) => console.log(`   ${t.name.padEnd(20)} ${String(t.email).padEnd(34)} ${t.dbName}`));

  console.log('\nTenant-shaped collections sitting in the MASTER database:');
  let total = 0;

  for (const name of LEAKED) {
    const exists = await master.listCollections({ name }).hasNext();
    if (!exists) continue;

    const docs = await master.collection(name).find({}).toArray();
    if (!docs.length) {
      console.log(`   ${name}: empty collection (safe to drop)`);
      continue;
    }

    total += docs.length;
    console.log(`\n   ${name}: ${docs.length} document(s)`);
    for (const d of docs) {
      const when = d.createdAt ? new Date(d.createdAt).toISOString() : '—';
      console.log(`      id=${d.id}  name="${d.name}"  stock=${d.stock ?? '—'}  created=${when}`);
    }
  }

  console.log(`\nTotal misplaced documents: ${total}`);
  if (total) {
    console.log('\nNone of these documents carry a tenant id, so which shop each one');
    console.log('belongs to cannot be recovered from the data itself.');
  }

  console.log('\nWhat each tenant database holds today:');
  for (const t of tenants) {
    const db = mongoose.connection.useDb(t.dbName, { useCache: true }).db;
    const counts = {};
    for (const c of ['products', 'categories', 'sales', 'customers', 'vendors', 'journal']) {
      counts[c] = await db.collection(c).countDocuments().catch(() => 0);
    }
    console.log(`   ${t.dbName.padEnd(30)} ${JSON.stringify(counts)}`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
