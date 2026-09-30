// Regenerates every product SKU in one tenant DB. Usage: node scripts/regen-skus.js <dbName> [--apply]
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getStoreBarcodeFormat } = require('../modules/barcodeFormat');

async function main() {
  const dbName = process.argv[2];
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.ADMIN_BE_URL || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.useDb(dbName, { useCache: true }).db;

  const settingsDoc = await db.collection('meta').findOne({ _key: 'settings' });
  const fields = getStoreBarcodeFormat({ settings: settingsDoc?.value });
  const skuField = fields.find((f) => f.type === 'sku');
  const idField = fields.find((f) => f.type === 'id');
  const len = Math.max(1, Number(skuField?.enabled !== false && skuField?.length ? skuField.length : (idField?.length || skuField?.length || 5)));

  const products = await db.collection('products').find({}).sort({ _id: 1 }).toArray();
  // Codes that must not collide: everything except the SKUs being replaced.
  const used = new Set();
  for (const p of products) {
    if (p.barcode) used.add(String(p.barcode).trim());
    (p.barcodes || []).forEach((b) => b && used.add(String(b).trim()));
    if (p.embeddedId) used.add(String(p.embeddedId).trim());
  }

  let n = Math.pow(10, len - 1);
  const max = Math.pow(10, len) - 1;
  const changes = [];
  for (const p of products) {
    let code;
    do { code = String(n++).padStart(len, '0'); } while (used.has(code) && n <= max + 1);
    if (n > max + 1) throw new Error('Ran out of codes');
    used.add(code);
    changes.push({ _id: p._id, id: p.id, name: p.name, oldSku: p.sku ?? null, newSku: code });
  }

  console.log(`${dbName}: ${products.length} products, ${len}-digit SKUs, ${changes[0]?.newSku} → ${changes.at(-1)?.newSku}`);
  if (!apply) { console.log('Dry run. Re-run with --apply.'); return; }

  const backup = `scripts/sku-backup-${dbName}-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify(changes.map(({ _id, ...c }) => c), null, 2));
  await db.collection('products').bulkWrite(changes.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { sku: c.newSku } } } })));
  await db.collection('meta').updateOne({ _key: 'skuSeq' }, { $set: { _key: 'skuSeq', value: n - 1, updatedAt: new Date() } }, { upsert: true });
  console.log(`Applied. Old values backed up to ${backup}`);
}
main().then(() => mongoose.disconnect()).catch((e) => { console.error('ERR', e.message); process.exit(1); });
