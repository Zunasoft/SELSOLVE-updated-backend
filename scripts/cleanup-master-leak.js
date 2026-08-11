/**
 * Remove the tenant-shaped collections that the old code wrote into the MASTER
 * database. The master database should hold only platform records: tenants,
 * plans, superadmins, settings, auditlogs, devices, subscriptions, payments.
 *
 * Everything is written to a JSON backup file first.
 *
 *   node scripts/cleanup-master-leak.js            # dry run, shows what it would do
 *   node scripts/cleanup-master-leak.js --confirm  # take the backup and delete
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

/** Collections that belong to a tenant database, never to master. */
const TENANT_SHAPED = [
  'products',
  'categories',
  'warehouses',
  'pricesheets',
  'stockmovements',
  'sales',
  'parties',
  'customers',
  'vendors',
  'journal',
  'purchases',
  'heldbills',
  'recipes',
  'accounts'
];

/** Collections the master database is supposed to have. */
const MASTER_OWNED = ['tenants', 'plans', 'superadmins', 'settings', 'auditlogs', 'devices', 'subscriptions', 'payments', 'otps'];

const confirm = process.argv.includes('--confirm');

(async () => {
  await mongoose.connect(process.env.ADMIN_BE_URL || process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const master = mongoose.connection.db;
  console.log(`Connected to master database "${master.databaseName}".\n`);

  const present = (await master.listCollections().toArray()).map((c) => c.name);
  const targets = TENANT_SHAPED.filter((c) => present.includes(c));

  if (!targets.length) {
    console.log('Nothing to clean — master holds no tenant-shaped collections.');
    await mongoose.disconnect();
    return;
  }

  const backup = {};
  let total = 0;
  for (const name of targets) {
    backup[name] = await master.collection(name).find({}).toArray();
    total += backup[name].length;
    console.log(`  ${name}: ${backup[name].length} document(s)`);
  }

  const unexpected = present.filter((c) => !MASTER_OWNED.includes(c) && !TENANT_SHAPED.includes(c));
  if (unexpected.length) console.log(`\n  (left alone, not recognised either way: ${unexpected.join(', ')})`);

  if (!confirm) {
    console.log(`\nDRY RUN — ${total} document(s) across ${targets.length} collection(s) would be backed up and dropped.`);
    console.log('Re-run with --confirm to apply.');
    await mongoose.disconnect();
    return;
  }

  const file = path.join(__dirname, `master-leak-backup-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written to ${file}`);

  for (const name of targets) {
    await master.collection(name).drop();
    console.log(`  dropped ${name}`);
  }

  console.log(`\nDone. Master database now holds only platform records.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
