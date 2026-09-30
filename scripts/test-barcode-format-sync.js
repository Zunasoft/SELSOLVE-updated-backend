/**
 * Cross-repo drift check: encodes weight-embedded barcodes with THIS repo's real encoder
 * (modules/barcodeFormat.js) and decodes them with the POS frontend's client-side decode mirror
 * (SELSOVE-Updated-POS/src/lib/barcodeDecode.js). The format is now ONE shared shape for the whole
 * store (Settings → Barcode) rather than per-product — this test exercises that
 * store-wide shape plus each product's own id/flag, since the two sides have quietly drifted apart
 * before (once over the check-digit field, once over min/max bounds), each time a silent runtime
 * bug rather than a loud one.
 *
 * Assumes the two repos are checked out as sibling directories (as they are in this environment);
 * override with the FRONTEND_REPO env var if that's not the case.
 *
 * Run: node scripts/test-barcode-format-sync.js
 */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { encodeBarcodeFormat, validateBarcode, maxLabelQuantity } = require('../modules/barcodeFormat');
const { generateSku, generateBarcode } = require('../controllers/catalog.controller');

const frontendRepo = process.env.FRONTEND_REPO || path.resolve(__dirname, '..', '..', 'SELSOVE-Updated-POS');
const decodeModulePath = path.join(frontendRepo, 'src', 'lib', 'barcodeDecode.js');

let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail !== undefined ? `  → ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail !== undefined ? `  → ${detail}` : ''}`);
  }
}

function storeWith(fields) {
  return { settings: { barcodeFormat: fields }, products: [] };
}

function product(id, flag, extra = {}) {
  return { id: 'p_test', requiresWeight: true, embeddedId: id, weightFlag: flag, ...extra };
}

async function main() {
  if (!fs.existsSync(decodeModulePath)) {
    console.error(`Frontend decode module not found at ${decodeModulePath}.`);
    console.error('Set FRONTEND_REPO to the SELSOVE-Updated-POS checkout if it is not a sibling of this repo.');
    process.exit(1);
  }

  const { tryDecodeForProductLocal } = await import(pathToFileURL(decodeModulePath).href);

  console.log(`Comparing backend encodeBarcodeFormat() against ${path.relative(process.cwd(), decodeModulePath)}\n`);

  // 1. Default shape (id + flag + value, sku off), weight mode.
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 5, precision: 3 }];
    const store = storeWith(fields);
    const p = product('10001', 'W');
    const code = encodeBarcodeFormat(store, p, 2.375);
    ok('Default shape encodes as expected', code === '10001W02375', code);
    ok('Frontend mirror decodes the same quantity', tryDecodeForProductLocal(fields, p, code) === 2.375, tryDecodeForProductLocal(fields, p, code));
  }

  // 2. Piece-count mode.
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 4, precision: 0 }];
    const store = storeWith(fields);
    const p = product('20002', 'P');
    const code = encodeBarcodeFormat(store, p, 12);
    ok('Piece-count encodes as a whole number', code === '20002P0012', code);
    ok('Frontend mirror decodes the same count', tryDecodeForProductLocal(fields, p, code) === 12, tryDecodeForProductLocal(fields, p, code));
  }

  // 3. SKU field enabled — a scan carries Product ID OR SKU, never both concatenated (matches
  //    Settings → Barcode's "OR, identified by SKU instead" preview line).
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: true, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 6, precision: 3 }];
    const store = storeWith(fields);
    const p = product('30003', 'W', { sku: '99999' });

    const idCode = encodeBarcodeFormat(store, p, 10.5);
    ok('SKU enabled: default encode still identifies by Product ID only', idCode === '30003W010500', idCode);
    ok('Product-ID code decodes correctly', tryDecodeForProductLocal(fields, p, idCode) === 10.5, `${idCode} -> ${tryDecodeForProductLocal(fields, p, idCode)}`);

    const skuCode = encodeBarcodeFormat(store, p, 10.5, { identifyBy: 'sku' });
    ok('identifyBy sku encodes the SKU instead of the id', skuCode === '99999W010500', skuCode);
    ok('SKU code decodes correctly too', tryDecodeForProductLocal(fields, p, skuCode) === 10.5, `${skuCode} -> ${tryDecodeForProductLocal(fields, p, skuCode)}`);
  }

  // 4. Custom flag letter (extensible type system) — same store-wide shape, different products.
  {
    const fields = [{ type: 'id', length: 4 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 5, precision: 3 }];
    const store = storeWith(fields);
    const p = product('4004', 'L');
    const code = encodeBarcodeFormat(store, p, 1.5);
    ok('Custom flag letter round-trips', tryDecodeForProductLocal(fields, p, code) === 1.5, `${code} -> ${tryDecodeForProductLocal(fields, p, code)}`);
  }

  // 5. Wrong product must not decode against this one.
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 5, precision: 3 }];
    const p = product('50005', 'W');
    const foreignCode = '99999W01000';
    ok('A code for a different product id is rejected, not misread', tryDecodeForProductLocal(fields, p, foreignCode) === null);
  }

  // 6. Overflow value clamps identically on both sides.
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 5, precision: 3 }];
    const store = storeWith(fields);
    const p = product('60006', 'W');
    const code = encodeBarcodeFormat(store, p, 200); // needs 200000 raw, only 5 digits available -> clamps to 99999
    const decoded = tryDecodeForProductLocal(fields, p, code);
    ok('Overflow clamps to the same max on both sides', code === '60006W99999' && decoded === 99.999, `${code} -> ${decoded}`);
  }

  // 7. Two different products sharing the SAME store-wide format, distinguished only by their own id/flag.
  {
    const fields = [{ type: 'id', length: 5 }, { type: 'sku', enabled: false, length: 5 }, { type: 'flag', length: 1 }, { type: 'value', length: 5, precision: 3 }];
    const store = storeWith(fields);
    const rice = product('70007', 'W');
    const nails = product('80008', 'P');
    const riceCode = encodeBarcodeFormat(store, rice, 3.2);
    const nailsCode = encodeBarcodeFormat(store, nails, 50);
    ok('Rice decodes only against its own id/flag', tryDecodeForProductLocal(fields, rice, riceCode) === 3.2 && tryDecodeForProductLocal(fields, nails, riceCode) === null);
    ok('Nails decodes only against its own id/flag', tryDecodeForProductLocal(fields, nails, nailsCode) === 50 && tryDecodeForProductLocal(fields, rice, nailsCode) === null);
  }

  // 8. Separate Piece Count field — P labels use it (whole number), W labels use Weight; both decoders agree.
  {
    const fields = [{ type: 'flag', length: 1 }, { type: 'id', length: 5 }, { type: 'sku', enabled: true, length: 5 }, { type: 'value', length: 6, precision: 3 }, { type: 'pieces', length: 4 }];
    const store = storeWith(fields);
    const pen = { sku: '10010', unit: 'pcs', barcode: '00011', weightFlag: 'W', requiresWeight: true };
    const rice = { sku: '10102', unit: 'kg', barcode: '00103', requiresWeight: true };
    store.products = [pen, rice];

    const penCode = encodeBarcodeFormat(store, pen, 3, { identifyBy: 'sku' });
    ok('Piece label uses the Piece Count digits (4)', penCode === 'P100100003', penCode);
    ok('Frontend decodes the piece label', tryDecodeForProductLocal(fields, pen, penCode) === 3);
    ok('Backend decodes the piece label', validateBarcode(store, penCode).quantity === 3);
    ok('A W label is rejected for a pcs product even with W saved (unit decides)', tryDecodeForProductLocal(fields, pen, 'W100100003') === null);

    const riceCode = encodeBarcodeFormat(store, rice, 0.2, { identifyBy: 'sku' });
    ok('Weight label still uses Weight digits + precision', riceCode === 'W10102000200' && tryDecodeForProductLocal(fields, rice, riceCode) === 0.2, riceCode);

    ok('Short piece form reads as 1 — frontend', tryDecodeForProductLocal(fields, pen, 'P10010') === 1);
    ok('Short piece form reads as 1 — backend', validateBarcode(store, 'P10010').quantity === 1);
    ok('Weight items have no short form', tryDecodeForProductLocal(fields, rice, 'W10102') === null);

    const idFields = [{ type: 'flag', length: 1 }, { type: 'id', length: 5 }, { type: 'value', length: 6, precision: 3 }, { type: 'pieces', length: 4 }];
    ok('Product barcode works as the label id — both sides', tryDecodeForProductLocal(idFields, pen, 'P000110007') === 7 && validateBarcode({ ...storeWith(idFields), products: [pen] }, 'P000110007').quantity === 7);

    ok('Max quantity per label type', maxLabelQuantity(store, pen) === 9999 && maxLabelQuantity(store, rice) === 999.999);
    ok('Legacy format without a pieces row still reads P as a whole count', tryDecodeForProductLocal(fields.filter((f) => f.type !== 'pieces'), pen, 'P10010000012') === 12);
  }

  // 9. Generators — SKUs stay in the 1xxxx band, barcodes in the 0xxxx band, and both stop instead of spilling over.
  {
    const fmt = [{ type: 'flag', length: 1 }, { type: 'id', length: 5 }, { type: 'sku', enabled: true, length: 5 }, { type: 'value', length: 6, precision: 3 }];
    const mk = (products, digits = 5) => ({ settings: { barcode: { digits }, barcodeFormat: fmt.map((f) => ({ ...f })) }, products });
    ok('First SKU is 10000', generateSku(mk([])) === '10000');
    ok('Barcode starts at 00001', generateBarcode(mk([])) === '00001');
    const fullSku = Array.from({ length: 10000 }, (_, i) => ({ sku: String(10000 + i) }));
    let skuErr = '';
    try { generateSku(mk(fullSku)); } catch (e) { skuErr = e.message; }
    ok('SKU stops at 19999 with a clear message', /10000 to 19999/.test(skuErr) && /Increase the SKU length/.test(skuErr));
    const fullBar = Array.from({ length: 9999 }, (_, i) => ({ barcode: String(i + 1).padStart(5, '0') }));
    let barErr = '';
    try { generateBarcode(mk(fullBar)); } catch (e) { barErr = e.message; }
    ok('Barcode stops at 09999 with a clear message', /1 to 9999/.test(barErr) && /Increase the barcode digits/.test(barErr));
    ok('Unit barcodes are treated as used', generateBarcode(mk([{ barcode: '00001', altUnits: [{ barcode: '00002' }], customSubUnitBarcode: '00003' }])) === '00004');
  }

  console.log(`\n${'='.repeat(52)}\n  ${passed} passed, ${failed} failed\n${'='.repeat(52)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
