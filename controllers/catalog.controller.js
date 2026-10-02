/**
 * Catalog Controller
 * Business logic for Products, Categories, Units, Price Sheets, Stock Adjustments & Bulk Import.
 *
 * Persistence note: these handlers only mutate `req.tenantStore`. That store was
 * loaded from the calling tenant's own database by `resolveTenantDb`, and is
 * written back to that same database before the response is sent. Nothing here
 * may write to the master database — doing so is what previously pooled every
 * shop's catalogue into one shared collection.
 */

const { logStockMovement, DEFAULT_UNITS, defaultPriceSheets, calculateProductStock, sortPriceSheets, priceSheetsView, globalSheetView } = require('../store');
const posting = require('../accounting/posting');
const { setRecipe, removeRecipe, decorateRecipe, recipeFromProductPayload } = require('../modules/recipes');
const { shapeBatches, writeOffBatch } = require('./batches');
const { shapeSerials, shapeSerialCustomLabels } = require('./serials');
const { enforceQtyPrecision, isWholeNumberUnit } = require('./unitConversion');
const { getStoreBarcodeFormat, encodeBarcodeFormat } = require('../modules/barcodeFormat');

const actor = (req) => req.headers['x-user-name'] || 'Owner';
const num = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const cleaned = String(v).replace(/[₹$,\s]/g, '');
  const val = Number(cleaned);
  return isNaN(val) ? fallback : val;
};
const randomBarcode = () => Math.floor(1000000000 + Math.random() * 9000000000).toString();

/**
 * Smallest available number in [floor, 10^digits - 1] whose formatted candidate isn't already in
 * `used` — a fresh scan against CURRENT product data every call, rather than an ever-advancing
 * counter, so three things fall out for free:
 *   1. No duplicates — every candidate is checked against everything actually in use right now.
 *   2. Deleted codes get reclaimed — a product that's gone no longer blocks its old number.
 *   3. The result never exceeds the configured digit length — once the range [floor, max] is
 *      genuinely exhausted this throws instead of silently wrapping back into reused-looking
 *      numbers (what padStart+slice(-digits) used to do once the count passed the digit cap).
 */
function nextAvailableCode(floor, digits, used, format, maxOverride = null, exhaustedHint = '') {
  const max = maxOverride !== null ? maxOverride : Math.pow(10, digits) - 1;
  for (let n = floor; n <= max; n++) {
    const candidate = format(n);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`No ${digits}-digit codes left — every value from ${floor} to ${max} is already in use.${exhaustedHint}`);
}

/** Every barcode/SKU/Product-ID currently on any product, as literal strings — the shared collision set so a generated barcode can never equal an existing SKU (or vice versa) and a generated code never matches a Product ID either. */
function collectUsedCodes(store, extraUsed) {
  const used = new Set();
  (store.products || []).forEach((p) => {
    if (p.barcode) used.add(String(p.barcode).trim());
    if (Array.isArray(p.barcodes)) p.barcodes.forEach((b) => b && used.add(String(b).trim()));
    if (p.customSubUnitBarcode) used.add(String(p.customSubUnitBarcode).trim());
    if (Array.isArray(p.altUnits)) p.altUnits.forEach((u) => u?.barcode && used.add(String(u.barcode).trim()));
    if (p.sku) used.add(String(p.sku).trim());
    if (p.embeddedId) used.add(String(p.embeddedId).trim());
  });
  (extraUsed || []).forEach((x) => x && used.add(String(x).trim()));
  return used;
}

/**
 * Barcode Generation — sequential, prefix + fixed digit-length, configured in Settings > Barcode.
 * Starts from 1 (a 5-digit store's first barcode is "00001").
 */
function generateBarcode(store, extraUsed = []) {
  const cfg = store.settings?.barcode || {};
  const prefix = cfg.prefix ? String(cfg.prefix) : '';
  const formatFields = getStoreBarcodeFormat(store);
  const idField = formatFields.find((f) => f.type === 'id');
  const digits = Math.max(1, Number(cfg.digits) || Number(idField?.length) || 5);

  const used = collectUsedCodes(store, extraUsed);
  // Barcodes stay in the 0xxxx… band (00001–09999 at 5 digits) so they never look like a 1xxxx SKU —
  // running out stops here and asks for a longer barcode length instead of spilling into 1xxxx.
  const cap = digits >= 2 ? Math.pow(10, digits - 1) - 1 : null;
  const candidate = nextAvailableCode(
    1, digits, used, (n) => `${prefix}${String(n).padStart(digits, '0')}`, cap,
    ` Increase the barcode digits in Settings → Barcode to continue.`
  );
  store.barcodeSeq = parseInt(candidate.slice(prefix.length), 10);
  return candidate;
}
exports.generateBarcode = generateBarcode;

/**
 * Weight-embedded barcode's Product ID field — draws from the SAME shared collision set as
 * barcode/SKU (via collectUsedCodes) so it can't collide with either, but starts its own count
 * from 1 like barcode does, independent of the SKU numbering.
 */
function generateEmbeddedId(store, length, extraUsed = []) {
  const len = Math.max(1, Number(length) || 5);
  const used = collectUsedCodes(store, extraUsed);
  const candidate = nextAvailableCode(1, len, used, (n) => String(n).padStart(len, '0'));
  store.embeddedIdSeq = parseInt(candidate, 10);
  return candidate;
}
exports.generateEmbeddedId = generateEmbeddedId;

/**
 * SKU Generation — floors at the smallest number that fills the configured length (e.g. a 5-digit
 * SKU field starts at 10000, so the first generated SKU is "10001") rather than at 1, so a SKU
 * never looks like a low, barcode-shaped number ("00001") by coincidence.
 */
function generateSku(store, extraUsed = []) {
  const formatFields = getStoreBarcodeFormat(store);
  const skuField = formatFields.find((f) => f.type === 'sku');
  const idField = formatFields.find((f) => f.type === 'id');
  const len = Math.max(1, Number(skuField?.enabled !== false && skuField?.length ? skuField.length : (idField?.length || skuField?.length || 5)));

  const used = collectUsedCodes(store, extraUsed);
  // Starts at the smallest length-filling value (10000 for a 5-digit field).
  const floor = Math.pow(10, len - 1);
  // SKUs stay in the 1xxxx… band (10000–19999 at 5 digits) — running out never spills into 2xxxx,
  // it stops and asks for a longer SKU length (Settings → Barcode) so the next range is 100000+.
  const cap = len >= 2 ? 2 * Math.pow(10, len - 1) - 1 : null;
  const candidate = nextAvailableCode(
    floor, len, used, (n) => String(n).padStart(len, '0'), cap,
    ` Increase the SKU length in Settings → Barcode to continue (a ${len + 1}-digit SKU starts at ${Math.pow(10, len)}).`
  );
  store.skuSeq = parseInt(candidate, 10);
  return candidate;
}
exports.generateSku = generateSku;

function validateProductUniqueness(store, product, excludeId = null) {
  const otherProducts = (store.products || []).filter((p) => p.id !== excludeId);

  // 1. Same-product Barcode vs SKU vs EmbeddedID collision check
  if (product.sku) {
    const skuClean = String(product.sku).trim();
    if (product.barcode && String(product.barcode).trim() === skuClean) {
      return {
        valid: false,
        message: `Barcode and SKU code cannot be the same ("${skuClean}"). Barcode and SKU must differ.`
      };
    }
    if (Array.isArray(product.barcodes) && product.barcodes.some((b) => String(b || '').trim() === skuClean)) {
      return {
        valid: false,
        message: `SKU code ("${skuClean}") cannot be identical to any Barcode on this product. They must differ.`
      };
    }
    if (product.embeddedId && String(product.embeddedId).trim() === skuClean) {
      return {
        valid: false,
        message: `Product ID ("${skuClean}") and SKU code cannot be the same. They must differ.`
      };
    }
  }
  if (product.barcode && product.embeddedId && String(product.barcode).trim() === String(product.embeddedId).trim()) {
    return {
      valid: false,
      message: 'Barcode and Product ID cannot be the same. They must differ.'
    };
  }

  // 2. SKU uniqueness check across all other products
  if (product.sku) {
    const skuClean = String(product.sku).trim();
    const conflict = otherProducts.find((p) => String(p.sku || '').trim() === skuClean);
    if (conflict) {
      return {
        valid: false,
        message: `SKU "${skuClean}" is already in use by "${conflict.name}". Each product must have a unique SKU.`
      };
    }
  }

  // 3. Barcodes uniqueness check across all other products
  const candidateBarcodes = [
    product.barcode,
    ...(Array.isArray(product.barcodes) ? product.barcodes : [])
  ].map((b) => String(b || '').trim()).filter(Boolean);

  for (const b of candidateBarcodes) {
    const conflict = otherProducts.find((p) => {
      const mainMatch = String(p.barcode || '').trim() === b;
      const altMatch = Array.isArray(p.barcodes) && p.barcodes.some((alt) => String(alt || '').trim() === b);
      return mainMatch || altMatch;
    });
    if (conflict) {
      return {
        valid: false,
        message: `Barcode "${b}" is already assigned to "${conflict.name}". Barcodes must be unique across all products.`
      };
    }
  }

  return { valid: true };
}
exports.validateProductUniqueness = validateProductUniqueness;


function shapeAltUnits(payload, existing, baseUnit) {
  const source = Array.isArray(payload.altUnits)
    ? payload.altUnits
    : Array.isArray(existing?.altUnits)
      ? existing.altUnits
      : [];

  const seen = new Set([String(baseUnit).toLowerCase()]);

  return source
    .filter((u) => u && u.unit && Number(u.factor) > 0)
    .filter((u) => {
      const key = String(u.unit).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((u) => ({
      unit: String(u.unit).toLowerCase(),
      factor: Number(u.factor),
      price: u.price === undefined || u.price === '' ? null : Number(u.price),
      mrp: u.mrp === undefined || u.mrp === '' ? null : Number(u.mrp),
      barcode: u.barcode ? String(u.barcode).trim() : '',
      isDefaultSaleUnit: Boolean(u.isDefaultSaleUnit)
    }));
}

function shapeCategoryIds(payload, existing, store) {
  let ids;
  if (Array.isArray(payload.categoryIds)) {
    ids = payload.categoryIds;
  } else if (typeof payload.categoryIds === 'string' && payload.categoryIds.trim()) {
    ids = payload.categoryIds.split(',');
  } else if (payload.categoryId) {
    ids = [payload.categoryId];
  } else if (Array.isArray(existing?.categoryIds) && existing.categoryIds.length) {
    ids = existing.categoryIds;
  } else if (existing?.categoryId) {
    ids = [existing.categoryId];
  } else {
    ids = [store?.categories?.[0]?.id || 'cat_1'];
  }
  const clean = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  return clean.length ? clean : [store?.categories?.[0]?.id || 'cat_1'];
}

function canonicalProductType(val) {
  if (!val) return 'standard';
  const clean = String(val).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.includes('both') || (clean.includes('raw') && (clean.includes('standard') || clean.includes('std') || clean.includes('product')))) {
    return 'both';
  }
  if (clean.includes('service') || clean.includes('repair')) return 'service';
  if (clean.includes('combo') || clean.includes('bundle')) return 'combo';
  if (clean.includes('composite') || clean.includes('recipe')) return 'composite';
  if (clean === 'raw' || clean === 'rawmaterial' || clean === 'rm' || clean.includes('raw')) {
    return 'raw';
  }
  return 'standard';
}

function shapeProductTypes(payload, existing) {
  const raw =
    payload.productType ||
    (Array.isArray(payload.productTypes) && payload.productTypes.length ? payload.productTypes[0] : null) ||
    existing?.productType ||
    (Array.isArray(existing?.productTypes) && existing.productTypes.length ? existing.productTypes[0] : null) ||
    'standard';
  const type = canonicalProductType(raw);
  const types = type === 'both' ? ['standard', 'raw'] : [type];
  return types;
}

function getTenantUnits(store) {
  if (!Array.isArray(store.units) || store.units.length === 0) {
    store.units = DEFAULT_UNITS.map((u) => ({ ...u }));
    return store.units;
  }
  if (typeof store.units[0] === 'string') {
    const defaultMap = Object.fromEntries(DEFAULT_UNITS.map((u) => [u.name, u]));
    store.units = store.units.map((name) => {
      const n = String(name).toLowerCase().trim();
      if (defaultMap[n]) return { ...defaultMap[n] };
      return { name: n, subUnit: null, factor: null, locked: false };
    });
  }
  return store.units;
}

function findUnit(units, name) {
  const clean = String(name).toLowerCase().trim();
  return units.find((u) => u.name === clean);
}

// The "Global Sheet" mirrors the products' own prices (see refreshGlobalSheet in store.js). It is created once, and it
// is where price changes can be typed in directly — e.g. on the purchase screen — instead of editing stock separately.
function ensureLocalSheet(store) {
  const sheets = store.priceSheets;
  const existing = sheets.find((s) => s.isLocal);
  if (existing) {
    // Created earlier under its first name.
    if (existing.name === 'Local Sheet') existing.name = 'Global Sheet';
    if (existing.code === 'LOCAL') existing.code = 'GLOBAL';
    // Earlier versions stored a copy of the prices here; they are read from the products now, so drop the stale copy.
    ['pricingMap', 'costMap', 'mrpMap', 'discountMap', 'marginMap'].forEach((key) => {
      if (existing[key] && Object.keys(existing[key]).length) existing[key] = {};
    });
    return;
  }
  sheets.push({
    id: 'ps_local',
    name: 'Global Sheet',
    code: 'GLOBAL',
    customerType: 'Retail',
    defaultDiscountPercent: 0,
    isActive: true,
    isLocal: true,
    pricingMap: {},
    costMap: {},
    mrpMap: {},
    discountMap: {},
    createdAt: new Date().toISOString()
  });
}

function getTenantPriceSheets(store) {
  if (!Array.isArray(store.priceSheets) || store.priceSheets.length === 0) {
    store.priceSheets = defaultPriceSheets();
  }
  ensureLocalSheet(store);
  return sortPriceSheets(store.priceSheets);
}


/** Numeric-only: any letters/symbols a user types are stripped, not stored. */
const cleanSku = (value) => String(value ?? '').replace(/\D/g, '');

function shapeProduct(store, payload, existing = null, updatedBy = 'Owner') {
  const enteredSku = payload.sku !== undefined ? cleanSku(payload.sku) : (existing?.sku ? cleanSku(existing.sku) : '');
  const enteredBarcode = payload.barcode ? String(payload.barcode).trim() : (existing?.barcode ? String(existing.barcode).trim() : (payload.defaultBarcode ? String(payload.defaultBarcode).trim() : ''));
  const payloadBarcodes = Array.isArray(payload.barcodes)
    ? payload.barcodes
    : typeof payload.barcodes === 'string'
      ? payload.barcodes.split(',')
      : (existing?.barcodes || []);
  const cleanAltBarcodes = payloadBarcodes.map((b) => String(b || '').trim()).filter(Boolean);

  const barcode =
    enteredBarcode ||
    (store.settings?.barcode?.autoGenerate === false ? randomBarcode() : generateBarcode(store, [enteredSku, ...cleanAltBarcodes]));
  const sku = enteredSku !== ''
    ? enteredSku
    : existing?.sku || generateSku(store, [barcode, ...cleanAltBarcodes]);

  let barcodes = [];
  if (cleanAltBarcodes.length) {
    barcodes = [...new Set(cleanAltBarcodes)];
  } else if (existing?.barcodes?.length) {
    barcodes = [...existing.barcodes];
  } else {
    barcodes = [barcode];
  }

  if (!barcodes.includes(barcode)) barcodes.unshift(barcode);

  let barcodeDetails = [];
  if (Array.isArray(payload.barcodeDetails) && payload.barcodeDetails.length) {
    barcodeDetails = payload.barcodeDetails
      .filter((b) => b && (b.code || b.barcode))
      .map((b) => ({
        code: String(b.code || b.barcode).trim(),
        type: b.type || 'alternate'
      }));
  } else if (Array.isArray(existing?.barcodeDetails) && existing.barcodeDetails.length) {
    barcodeDetails = existing.barcodeDetails;
  } else {
    barcodeDetails = barcodes.map((c, i) => ({
      code: c,
      type: c === barcode || i === 0 ? 'primary' : 'alternate'
    }));
  }

  const price = num(payload.price, existing?.price ?? 0);
  const purchasePrice = num(payload.purchasePrice, existing?.purchasePrice ?? Math.round(price * 0.7));

  let warehouses = payload.warehouses || existing?.warehouses;
  if (!warehouses || typeof warehouses !== 'object') {
    const totalStk = num(payload.stock, existing?.stock ?? 0);
    warehouses = {
      wh_main: Math.max(0, totalStk - 10),
      wh_shop: Math.min(totalStk, 10)
    };
  }

  let stock = num(payload.stock, existing?.stock ?? 0);
  if (payload.warehouses && typeof payload.warehouses === 'object') {
    stock = Object.values(payload.warehouses).reduce((sum, v) => sum + num(v, 0), 0);
  }

  const trackBatches = payload.trackBatches !== undefined ? Boolean(payload.trackBatches) : Boolean(existing?.trackBatches);
  let batches = shapeBatches(payload, existing);

  // Turning batch tracking on for a product that already has stock and no
  // batches supplied yet: fold the existing stock into one "Opening Stock"
  // batch so nothing is lost, rather than starting the product at zero.
  if (trackBatches && !existing?.trackBatches && !Array.isArray(payload.batches) && batches.length === 0 && stock > 0) {
    batches = [{
      id: `batch_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      batchNo: 'OPENING-STOCK',
      mfgDate: null,
      expiryDate: null,
      qty: stock,
      costPrice: purchasePrice,
      sellPrice: null,
      refPurchaseId: null,
      warehouseId: (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main',
      source: 'opening',
      createdAt: new Date().toISOString()
    }];
  }

  // A batch-tracked product's stock is never edited directly — it's always
  // the sum of what's actually in its batches.
  if (trackBatches) {
    stock = Math.round(batches.reduce((sum, b) => sum + (Number(b.qty) || 0), 0) * 10000) / 10000;
    const defaultWh = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
    const whMap = {};
    batches.forEach((b) => {
      const whId = b.warehouseId || defaultWh;
      whMap[whId] = Math.round(((whMap[whId] || 0) + (Number(b.qty) || 0)) * 10000) / 10000;
    });
    warehouses = whMap;
  }

  // Serial tracking is the other end of the same idea as batches — for a
  // product that isn't lot/expiry-managed but where every unit needs its own
  // traceable identity (electronics, etc.) — so the two are mutually
  // exclusive on one product. Each serial is exactly one physical unit
  // (there's no "qty" to sum), so stock is simply the count still in hand.
  const trackSerials = trackBatches
    ? false
    : payload.trackSerials !== undefined
    ? Boolean(payload.trackSerials)
    : Boolean(existing?.trackSerials);
  const serialCustomLabels = shapeSerialCustomLabels(payload, existing);
  let serials = trackSerials ? shapeSerials(payload, existing) : (existing?.trackSerials ? existing.serials || [] : []);

  if (trackSerials) {
    stock = serials.filter((s) => s.status === 'IN_STOCK').length;
    const defaultWh = (store.warehouses || []).find((w) => w.isDefault)?.id || 'wh_main';
    const whMap = {};
    serials.forEach((s) => {
      if (s.status !== 'IN_STOCK') return;
      const whId = s.warehouseId || defaultWh;
      whMap[whId] = (whMap[whId] || 0) + 1;
    });
    warehouses = whMap;
  }

  const productTypes = shapeProductTypes(payload, existing);
  const productType = productTypes[0];

  let pricingHistory = existing?.pricingHistory || [];
  if (existing && (existing.price !== price || existing.purchasePrice !== purchasePrice)) {
    pricingHistory.unshift({
      date: new Date().toISOString(),
      oldPrice: existing.price,
      newPrice: price,
      oldPurchasePrice: existing.purchasePrice,
      newPurchasePrice: purchasePrice,
      updatedBy
    });
    if (pricingHistory.length > 50) pricingHistory.pop();
  }

  const unit = payload.unit || existing?.unit || 'pcs';
  const categoryIds = shapeCategoryIds(payload, existing, store);

  return {
    id: existing?.id || `p_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    name: payload.name ?? existing?.name ?? 'Untitled Product',
    printName: payload.regionalName ?? payload.printName ?? existing?.regionalName ?? existing?.printName ?? '',
    regionalName: payload.regionalName ?? payload.printName ?? existing?.regionalName ?? existing?.printName ?? '',
    description: payload.description ?? existing?.description ?? '',
    categoryId: categoryIds[0],
    categoryIds,
    barcode,
    sku,
    barcodes,
    barcodeDetails,
    defaultBarcode: barcode,
    hsn: payload.hsn ?? existing?.hsn ?? '',
    unit,
    altUnits: shapeAltUnits(payload, existing, unit),
    productType,
    productTypes,
    price,
    mrp: num(payload.mrp, existing?.mrp ?? price),
    purchasePrice,
    // Margin isn't used in any pricing math itself (Selling Price/MRP stay the
    // source of truth billing reads) — each is stored purely so re-opening
    // Add/Edit Product shows the same margins the user configured last time,
    // instead of them resetting blank. Selling Price and MRP each keep their
    // own independent margin — they're priced differently, not off one shared number.
    // Falls back to the old single `marginPercent` field for a product saved before the SP/MRP
    // split — without this, every pre-existing product's configured margin would silently reset
    // blank the first time it's opened, since the old field is never read by name otherwise.
    marginPercentSp: payload.marginPercentSp !== undefined
      ? String(payload.marginPercentSp)
      : (existing?.marginPercentSp ?? existing?.marginPercent ?? ''),
    marginPercentMrp: payload.marginPercentMrp !== undefined
      ? String(payload.marginPercentMrp)
      : (existing?.marginPercentMrp ?? existing?.marginPercent ?? ''),
    wholesalePrice: num(payload.wholesalePrice, existing?.wholesalePrice ?? price),
    specialPrice: num(payload.specialPrice, existing?.specialPrice ?? price),
    // Whole-number units (pcs, box, dozen, ...) can't carry fractional stock —
    // the same rule billing enforces on the way out applies here on the way in.
    stock: productType === 'service' ? 9999 : enforceQtyPrecision(unit, stock),
    minStock: enforceQtyPrecision(unit, num(payload.minStock, existing?.minStock ?? 5)),
    warehouses,
    trackBatches,
    batches,
    trackSerials,
    serials,
    serialCustomLabels,
    // Per-product override for the near-expiry alert window (days). Blank/null
    // means "use the store default" — a store's default might be 30 days,
    // but eggs at a 14-day shelf life need their own much shorter number.
    nearExpiryDays: payload.nearExpiryDays === '' || payload.nearExpiryDays === undefined
      ? (existing?.nearExpiryDays ?? null)
      : (Number(payload.nearExpiryDays) || null),
    imageUrl: payload.imageUrl ?? existing?.imageUrl ?? '',
    requiresWeight: payload.requiresWeight !== undefined ? Boolean(payload.requiresWeight) : Boolean(existing?.requiresWeight),
    // The field SHAPE (lengths/precision) is one store-wide setting now (Settings → Barcode) —
    // only this product's own id number and flag letter stay per-product.
    embeddedId: payload.embeddedId !== undefined ? String(payload.embeddedId) : (existing?.embeddedId || ''),
    weightFlag: payload.weightFlag !== undefined ? String(payload.weightFlag).slice(0, 1).toUpperCase() : (existing?.weightFlag || (['kg', 'g', 'gm', 'gms', 'gram', 'grams', 'lb', 'lbs', 'ltr', 'litre', 'l', 'ml'].includes(String(unit || '').toLowerCase()) ? 'W' : 'P')),
    taxRate: num(payload.taxRate, existing?.taxRate ?? 0),
    isComposite: productType === 'composite' || Boolean(payload.isComposite),
    comboItems: Array.isArray(payload.comboItems) ? payload.comboItems : existing?.comboItems || [],
    customSubUnitName: payload.customSubUnitName ?? existing?.customSubUnitName ?? '',
    customSubUnitFactor: num(payload.customSubUnitFactor, existing?.customSubUnitFactor ?? 0),
    customSubUnitPrice: num(payload.customSubUnitPrice, existing?.customSubUnitPrice ?? 0),
    customSubUnitMrp: num(payload.customSubUnitMrp, existing?.customSubUnitMrp ?? 0),
    customSubUnitBarcode: payload.customSubUnitBarcode ?? existing?.customSubUnitBarcode ?? '',
    enableMinorUnit: payload.enableMinorUnit !== undefined ? Boolean(payload.enableMinorUnit) : Boolean(existing?.enableMinorUnit),
    trackSerial: payload.trackSerial !== undefined ? Boolean(payload.trackSerial) : Boolean(existing?.trackSerial),
    serialNumbers: Array.isArray(payload.serialNumbers) ? payload.serialNumbers : (existing?.serialNumbers || []),
    // Warranty tracking — the clock only starts once a unit is actually
    // billed (see markSerialSold in controllers/serials.js), not from the
    // date it was added to the catalogue.
    hasWarranty: payload.hasWarranty !== undefined ? Boolean(payload.hasWarranty) : Boolean(existing?.hasWarranty),
    warrantyDurationValue: num(payload.warrantyDurationValue, existing?.warrantyDurationValue ?? 12),
    warrantyDurationUnit: payload.warrantyDurationUnit || existing?.warrantyDurationUnit || 'months',
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : existing?.isActive ?? true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
exports.shapeProduct = shapeProduct;

/* ------------------------------- Units Controllers ------------------------------- */

exports.getUnits = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  res.json({ success: true, data: units });
};

exports.createUnit = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  const { name, subUnit, factor } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Unit name is required.' });

  const clean = name.trim().toLowerCase();
  if (findUnit(units, clean)) return res.status(400).json({ success: false, message: 'Unit already exists.' });

  const unitObj = {
    name: clean,
    subUnit: subUnit ? String(subUnit).trim().toLowerCase() : null,
    factor: factor !== undefined && factor !== null && factor !== '' ? Number(factor) : null,
    locked: false
  };
  units.push(unitObj);
  res.status(201).json({ success: true, message: 'Unit created successfully.', data: unitObj });
};

exports.updateUnit = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  const oldName = req.params.oldName.toLowerCase();
  const { newName, subUnit, factor } = req.body;

  if (!newName || !newName.trim()) return res.status(400).json({ success: false, message: 'New unit name is required.' });

  const clean = newName.trim().toLowerCase();
  const existing = findUnit(units, oldName);
  if (!existing) return res.status(404).json({ success: false, message: 'Unit not found.' });

  // Rename the unit in all products if the name changed
  if (existing.name !== clean) {
    (req.tenantStore.products || []).forEach((p) => {
      if (p.unit === existing.name) p.unit = clean;
    });
    existing.name = clean;
  }

  // Update conversion fields (locked units keep their factor)
  if (!existing.locked) {
    existing.subUnit = subUnit !== undefined ? (subUnit ? String(subUnit).trim().toLowerCase() : null) : existing.subUnit;
    existing.factor = factor !== undefined ? (factor !== null && factor !== '' ? Number(factor) : null) : existing.factor;
  }

  res.json({ success: true, message: 'Unit updated.', data: existing });
};

exports.deleteUnit = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  const name = req.params.name.toLowerCase();

  const inUse = (req.tenantStore.products || []).some((p) => p.unit === name);
  if (inUse) {
    return res.status(400).json({ success: false, message: `Cannot delete unit "${name}" because it is currently assigned to products.` });
  }

  const index = units.findIndex((u) => u.name === name);
  if (index >= 0) units.splice(index, 1);

  res.json({ success: true, message: `Unit "${name}" deleted.` });
};

/* ----------------------------- Categories Controllers ----------------------------- */

exports.getCategories = (req, res) => {
  const store = req.tenantStore;
  res.json({
    success: true,
    data: store.categories.map((c) => ({
      ...c,
      productCount: (store.products || []).filter((p) => (p.categoryIds || [p.categoryId]).includes(c.id)).length
    }))
  });
};

exports.createCategory = (req, res) => {
  const { name, icon, description, kotPrinter, color } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });

  const category = {
    id: `cat_${Date.now()}`,
    name,
    icon: icon || '📦',
    description: description || '',
    kotPrinter: kotPrinter || '',
    color: color || '',
    createdAt: new Date().toISOString()
  };
  req.tenantStore.categories.push(category);

  res.status(201).json({ success: true, data: category });
};

exports.updateCategory = (req, res) => {
  const category = req.tenantStore.categories.find((c) => c.id === req.params.id);
  if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });

  Object.assign(category, req.body, { id: category.id, updatedAt: new Date().toISOString() });

  res.json({ success: true, data: category });
};

exports.deleteCategory = (req, res) => {
  const store = req.tenantStore;
  const inUse = (store.products || []).some((p) => (p.categoryIds || [p.categoryId]).includes(req.params.id));
  if (inUse) {
    return res.status(400).json({ success: false, message: 'Category is in use by existing products and cannot be deleted.' });
  }
  store.categories = store.categories.filter((c) => c.id !== req.params.id);

  res.json({ success: true, message: 'Category deleted.' });
};

/* ------------------------------- Products Controllers ------------------------------- */

exports.getProducts = (req, res) => {
  const store = req.tenantStore;
  const { q, categoryId, lowStock, outOfStock, productType, status } = req.query;

  // Ensure every product in store has an SKU code
  if (Array.isArray(store.products)) {
    store.products.forEach((p) => {
      if (!p.sku) {
        p.sku = generateSku(store);
      }
    });
  }

  let rows = store.products || [];
  if (categoryId && categoryId !== 'all') rows = rows.filter((p) => (p.categoryIds || [p.categoryId]).includes(categoryId));
  if (productType && productType !== 'all') rows = rows.filter((p) => (p.productTypes || [p.productType]).includes(productType));
  if (status === 'active') rows = rows.filter((p) => p.isActive !== false);
  if (status === 'inactive') rows = rows.filter((p) => p.isActive === false);

  if (lowStock === 'true') {
    rows = rows.filter((p) => {
      const status = calculateProductStock(p, store.products || [], store.recipes || []);
      return !status.isService && status.isLow;
    });
  }
  if (outOfStock === 'true') {
    rows = rows.filter((p) => {
      const status = calculateProductStock(p, store.products || [], store.recipes || []);
      return !status.isService && status.isOut;
    });
  }

  if (q) {
    const needle = String(q).toLowerCase();
    // Only fields a user actually searches by: name, SKU, and this product's own current barcode.
    // Not the internal `p.id` (an opaque timestamp-based key) or the legacy `p.barcodes` alternates
    // array — both are long digit strings that can contain a short typed number by coincidence,
    // surfacing a totally unrelated product.
    rows = rows.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.printName || '').toLowerCase().includes(needle) ||
        (p.regionalName || '').toLowerCase().includes(needle) ||
        (p.sku || '').toLowerCase().includes(needle) ||
        (p.barcode && String(p.barcode).includes(needle))
    );
  }

  // Composite products travel with their recipe so the edit form can open
  // fully populated without a second round trip.
  const data = rows.map((p) => {
    if (!p.isComposite && p.productType !== 'composite') return p;
    let recipe = (store.recipes || []).find((r) => r.productId === p.id);
    if (!recipe && Array.isArray(p.recipeItems) && p.recipeItems.length) {
      recipe = {
        id: `rec_${p.id}`,
        productId: p.id,
        productName: p.name,
        yieldQty: 1,
        ingredients: p.recipeItems,
        notes: p.recipeNotes || ''
      };
    }
    const decorated = recipe ? decorateRecipe(store, recipe) : null;
    return {
      ...p,
      recipeItems: p.recipeItems?.length ? p.recipeItems : (recipe?.ingredients || []),
      recipe: decorated
    };
  });

  res.json({ success: true, data });
};

exports.lookupProduct = (req, res) => {
  const needle = req.params.barcode;
  const product = (req.tenantStore.products || []).find(
    (p) => p.barcode === needle || p.id === needle || p.sku === needle || (p.barcodes || []).includes(needle) ||
      p.customSubUnitBarcode === needle || (p.altUnits || []).some((u) => u?.barcode === needle)
  );
  if (!product) return res.status(404).json({ success: false, message: 'No product matches that barcode, SKU or ID.' });
  res.json({ success: true, data: product });
};

/**
 * On-demand barcode/SKU generation for the product form's "Generate" buttons. These are PREVIEWS —
 * clicking Generate doesn't create a product, so unlike the fallback inside shapeProduct (which
 * always advances, because a product IS about to be saved with that value in the same request),
 * clicking Generate twice without ever saving must not burn two numbers. Each generator here first
 * checks whether the number it last handed out actually ended up on a saved product; if not, it
 * hands out that same number again instead of skipping past it.
 */

/** On-demand barcode generation for the product form's "Generate" button. */
exports.generateNextBarcode = (req, res) => {
  const store = req.tenantStore;
  const exclude = [
    req.body?.sku,
    req.body?.embeddedId,
    ...(Array.isArray(req.body?.barcodes) ? req.body.barcodes : []),
    ...(Array.isArray(req.body?.exclude) ? req.body.exclude : [])
  ].filter(Boolean).map((x) => String(x).trim());

  if (req.body?.requiresWeight) {
    const fields = getStoreBarcodeFormat(store);
    const idField = fields.find((f) => f.type === 'id');
    const len = Math.max(1, Number(idField?.length) || 5);
    const weightFlag = String(req.body.weightFlag || 'W').slice(0, 1).toUpperCase();

    const code = generateEmbeddedId(store, len, exclude);
    const isPiece = weightFlag === 'P';
    const example = encodeBarcodeFormat(store, req.body, isPiece ? 12 : 1.235, { embeddedId: code, weightFlag });
    return res.json({ success: true, data: { value: code, example } });
  }

  const code = generateBarcode(store, exclude);
  res.json({ success: true, data: { barcode: code } });
};

/** On-demand SKU generation for the product form's "Generate" button. */
exports.generateNextSku = (req, res) => {
  const store = req.tenantStore;
  const exclude = [
    req.body?.barcode,
    req.body?.embeddedId,
    ...(Array.isArray(req.body?.barcodes) ? req.body.barcodes : []),
    ...(Array.isArray(req.body?.exclude) ? req.body.exclude : [])
  ].filter(Boolean).map((x) => String(x).trim());

  const sku = generateSku(store, exclude);
  res.json({ success: true, data: { sku } });
};

exports.createProduct = (req, res) => {
  const store = req.tenantStore;
  if (!req.body || !req.body.name || req.body.price === undefined) {
    return res.status(400).json({ success: false, message: 'Product name and selling price are required.' });
  }

  const product = shapeProduct(store, req.body, null, actor(req));
  const uniqueness = validateProductUniqueness(store, product, null);
  if (!uniqueness.valid) {
    return res.status(400).json({ success: false, message: uniqueness.message });
  }
  if (!Array.isArray(store.products)) store.products = [];

  // Composite items carry their recipe on the same form — save both together so
  // a product can never exist as "composite" without the recipe that defines it.
  let recipe = null;
  const recipePayload = recipeFromProductPayload(req.body);
  if (product.isComposite || product.productType === 'composite') {
    if (!recipePayload || !Array.isArray(recipePayload.ingredients) || !recipePayload.ingredients.length) {
      return res.status(400).json({
        success: false,
        message: 'A composite product needs a recipe — add at least one raw material with a quantity.'
      });
    }
    // The product must be in the catalogue before the recipe can reference it.
    store.products.unshift(product);
    try {
      recipe = setRecipe(store, product, recipePayload);
    } catch (err) {
      store.products = store.products.filter((p) => p.id !== product.id);
      return res.status(400).json({ success: false, message: err.message });
    }
  } else {
    store.products.unshift(product);
  }

  if (product.productType !== 'service' && !product.isComposite && product.stock > 0) {
    logStockMovement(store, {
      product,
      type: 'OPENING',
      qtyChange: product.stock,
      reason: 'Initial stock on product creation',
      user: actor(req)
    });
    const value = product.stock * product.purchasePrice;
    if (value > 0) {
      posting.postStockAdjustment(
        store,
        { id: product.id, productName: product.name, reason: 'Opening stock', value, date: new Date().toISOString() },
        { createdBy: actor(req) }
      );
    }
  }

  res.status(201).json({
    success: true,
    message: recipe
      ? `Composite product created with ${recipe.ingredients.length} raw material(s).`
      : 'Product created successfully.',
    data: { ...product, recipe: recipe ? decorateRecipe(store, recipe) : null }
  });
};

exports.updateProduct = (req, res) => {
  const store = req.tenantStore;
  const index = (store.products || []).findIndex((p) => p.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, message: 'Product not found.' });

  const existing = store.products[index];
  const previousStock = existing.stock;

  // Once a product has real stock sitting in batches, dropping trackBatches
  // would strand that stock outside the batch system (FEFO consumption,
  // expiry alerts, per-batch cost) it's recorded against — so the flag can
  // only be turned off after every batch has been sold, transferred, or
  // written down to zero. Checked server-side too since the client can be
  // bypassed.
  if (existing.trackBatches && req.body.trackBatches !== undefined && !Boolean(req.body.trackBatches)) {
    const remaining = (existing.batches || []).reduce((sum, b) => sum + (Number(b.qty) || 0), 0);
    if (remaining > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot turn off batch tracking — ${remaining} unit(s) of batched stock still remain. Sell, transfer, or write off all batches first.`
      });
    }
  }

  const updated = shapeProduct(store, req.body, existing, actor(req));
  const uniqueness = validateProductUniqueness(store, updated, existing.id);
  if (!uniqueness.valid) {
    return res.status(400).json({ success: false, message: uniqueness.message });
  }
  store.products[index] = updated;

  // Recipe edits ride along with the product edit. `recipe: null` sent
  // explicitly, or switching the type away from composite, clears it.
  let recipe = null;
  const recipePayload = recipeFromProductPayload(req.body);
  const wantsComposite = updated.isComposite || updated.productType === 'composite';

  if (wantsComposite) {
    const carried = recipePayload || (store.recipes || []).find((r) => r.productId === updated.id);
    if (!carried || !Array.isArray(carried.ingredients) || !carried.ingredients.length) {
      store.products[index] = existing;
      return res.status(400).json({
        success: false,
        message: 'A composite product needs a recipe — add at least one raw material with a quantity.'
      });
    }
    try {
      recipe = setRecipe(store, updated, carried);
    } catch (err) {
      store.products[index] = existing;
      return res.status(400).json({ success: false, message: err.message });
    }
  } else if (existing.isComposite || recipePayload) {
    // Demoted back to a normal product — drop the recipe rather than leaving an
    // orphan that would still deduct raw materials on the next sale.
    removeRecipe(store, updated.id);
    updated.isComposite = false;
    updated.recipeItems = [];
  }

  if (updated.productType !== 'service' && !updated.isComposite && updated.stock !== previousStock) {
    const delta = updated.stock - previousStock;
    logStockMovement(store, {
      product: updated,
      type: 'ADJUSTMENT',
      qtyChange: delta,
      reason: 'Stock updated via product edit',
      user: actor(req)
    });
    posting.postStockAdjustment(
      store,
      {
        id: updated.id,
        productName: updated.name,
        reason: 'Product edit',
        value: delta * updated.purchasePrice,
        date: new Date().toISOString()
      },
      { createdBy: actor(req) }
    );
  }

  res.json({
    success: true,
    message: 'Product updated successfully.',
    data: { ...updated, recipe: recipe ? decorateRecipe(store, recipe) : null }
  });
};

exports.deleteProduct = (req, res) => {
  const store = req.tenantStore;
  const product = (store.products || []).find((p) => p.id === req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  // A raw material still referenced by a recipe cannot go — removing it would
  // leave that composite unable to cost or deduct itself.
  const usedIn = (store.recipes || []).filter((r) =>
    r.ingredients.some((i) => i.productId === product.id)
  );
  if (usedIn.length) {
    return res.status(400).json({
      success: false,
      message: `"${product.name}" is a raw material in ${usedIn.length} composite item(s): ${usedIn
        .map((r) => r.productName)
        .join(', ')}. Remove it from those recipes first.`
    });
  }

  store.products = store.products.filter((p) => p.id !== product.id);
  removeRecipe(store, product.id);

  res.json({ success: true, message: 'Product removed from catalog.' });
};

/** The recipe attached to one product, with live cost and producible figures. */
exports.getProductRecipe = (req, res) => {
  const store = req.tenantStore;
  const product = (store.products || []).find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const recipe = (store.recipes || []).find((r) => r.productId === product.id);
  res.json({ success: true, data: recipe ? decorateRecipe(store, recipe) : null });
};

/* ----------------------------- Price Sheets Controllers ----------------------------- */

exports.getPriceSheets = (req, res) => {
  getTenantPriceSheets(req.tenantStore); // makes sure the Global Sheet exists
  res.json({ success: true, data: priceSheetsView(req.tenantStore) });
};

exports.createPriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const { name, code, customerType, defaultDiscountPercent, pricingMap, discountMap } = req.body;

  if (!name) return res.status(400).json({ success: false, message: 'Price sheet name is required.' });

  const sheet = {
    id: `ps_${Date.now()}`,
    name,
    code: code || name.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
    customerType: customerType || 'Retail',
    defaultDiscountPercent: Number(defaultDiscountPercent) || 0,
    isActive: true,
    pricingMap: pricingMap || {},
    discountMap: discountMap || {},
    sortOrder: priceSheets.reduce((max, s) => Math.max(max, Number.isFinite(s.sortOrder) ? s.sortOrder : -1), priceSheets.length - 1) + 1,
    createdAt: new Date().toISOString()
  };

  priceSheets.push(sheet);

  res.status(201).json({ success: true, message: 'Price sheet created.', data: sheet });
};

// Drag-and-drop order from the Price Sheets screen: ids top to bottom. Sheets not mentioned keep their place after the listed ones.
exports.reorderPriceSheets = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ success: false, message: 'Send the sheet ids in the new order.' });

  const listed = ids.map((id) => priceSheets.find((s) => s.id === id)).filter(Boolean);
  const rest = priceSheets.filter((s) => !ids.includes(s.id));
  [...listed, ...rest].forEach((sheet, index) => {
    sheet.sortOrder = index;
  });
  sortPriceSheets(priceSheets);

  res.json({ success: true, message: 'Price sheet order saved.', data: priceSheets.map((s) => s.id) });
};

exports.updatePriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const sheet = priceSheets.find((s) => s.id === req.params.id);
  if (!sheet) return res.status(404).json({ success: false, message: 'Price sheet not found.' });

  const { name, code, customerType, defaultDiscountPercent, isActive, pricingMap, discountMap, costMap, mrpMap, marginMap } = req.body;
  if (name && !sheet.isLocal) sheet.name = name;
  if (code && !sheet.isLocal) sheet.code = code;
  if (sheet.isLocal) {
    // The Global Sheet has no prices of its own: whatever is typed here becomes the product's price / cost / MRP.
    let changed = 0;
    [[pricingMap, 'price'], [costMap, 'purchasePrice'], [mrpMap, 'mrp']].forEach(([map, field]) => {
      if (!map || typeof map !== 'object') return;
      Object.entries(map).forEach(([productId, raw]) => {
        const product = (req.tenantStore.products || []).find((p) => p.id === productId);
        const value = Number(raw);
        if (!product || raw === '' || raw === null || !Number.isFinite(value) || value < 0) return;
        if ((Number(product[field]) || 0) !== value) {
          product[field] = value;
          product.updatedAt = new Date().toISOString();
          changed += 1;
        }
      });
    });
    if (isActive !== undefined) sheet.isActive = Boolean(isActive);
    sheet.updatedAt = new Date().toISOString();
    return res.json({ success: true, message: changed ?`Updated pricing for ${changed} value(s) on the products.` : 'Nothing changed.', data: globalSheetView(req.tenantStore, sheet) });
  }
  if (customerType) sheet.customerType = customerType;
  if (defaultDiscountPercent !== undefined) sheet.defaultDiscountPercent = Number(defaultDiscountPercent) || 0;
  if (isActive !== undefined) sheet.isActive = Boolean(isActive);
  if (pricingMap && typeof pricingMap === 'object') sheet.pricingMap = { ...pricingMap };
  if (discountMap && typeof discountMap === 'object') sheet.discountMap = { ...discountMap };
  if (marginMap && typeof marginMap === 'object') sheet.marginMap = { ...marginMap };

  sheet.updatedAt = new Date().toISOString();

  res.json({ success: true, message: 'Price sheet updated.', data: sheet });
};

exports.deletePriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const index = priceSheets.findIndex((s) => s.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, message: 'Price sheet not found.' });
  if (priceSheets[index].isLocal) {
    return res.status(400).json({ success: false, message: 'The Global Sheet is built in and cannot be deleted. You can switch it off instead.' });
  }

  priceSheets.splice(index, 1);

  res.json({ success: true, message: 'Price sheet deleted.' });
};

exports.getPriceSheetGrid = (req, res) => {
  const store = req.tenantStore;
  const rows = (store.products || []).map((p) => {
    const categoryNames = (p.categoryIds || [p.categoryId])
      .map((id) => store.categories.find((c) => c.id === id)?.name)
      .filter(Boolean);
    const margin = p.price - p.purchasePrice;
    return {
      id: p.id,
      name: p.name,
      printName: p.printName || p.regionalName,
      regionalName: p.regionalName || p.printName,
      category: categoryNames.length ? categoryNames.join(', ') : '—',
      barcode: p.barcode,
      sku: p.sku || '',
      hsn: p.hsn,
      unit: p.unit,
      productType: p.productType,
      purchasePrice: p.purchasePrice,
      wholesalePrice: p.wholesalePrice,
      specialPrice: p.specialPrice,
      price: p.price,
      mrp: p.mrp,
      taxRate: p.taxRate,
      margin,
      marginPercent: p.purchasePrice ? Math.round((margin / p.purchasePrice) * 100) : 0,
      stock: p.stock,
      stockValue: Math.round(p.stock * p.purchasePrice)
    };
  });

  res.json({
    success: true,
    data: {
      rows,
      totalStockValue: Math.round(rows.reduce((s, r) => s + r.stockValue, 0)),
      totalRetailValue: Math.round((store.products || []).reduce((s, p) => s + p.stock * p.price, 0))
    }
  });
};

exports.updatePriceSheetGrid = (req, res) => {
  const store = req.tenantStore;
  const updates = Array.isArray(req.body.rows) ? req.body.rows : [];
  let count = 0;

  for (const row of updates) {
    const product = (store.products || []).find((p) => p.id === row.id);
    if (!product) continue;

    ['price', 'mrp', 'purchasePrice', 'wholesalePrice', 'specialPrice', 'taxRate'].forEach((field) => {
      // A blank, non-numeric or negative cell is skipped — it must never turn a real price into NaN or a minus.
      if (row[field] === undefined || row[field] === '' || row[field] === null) return;
      const value = Number(row[field]);
      if (Number.isFinite(value) && value >= 0) product[field] = value;
    });
    product.updatedAt = new Date().toISOString();
    count += 1;
  }

  res.json({ success: true, message: `Updated pricing for ${count} product(s).`, count });
};

/* ------------------------------- Bulk Import ------------------------------- */

function normalizeImportRow(row) {
  if (!row || typeof row !== 'object') return {};

  const cleanNumStr = (v) => {
    if (v === undefined || v === null) return '';
    return String(v).replace(/[₹$,\s]/g, '').trim();
  };

  const getVal = (...keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
        return String(row[k]).replace(/^\uFEFF/, '').trim();
      }
    }
    const rowKeys = Object.keys(row);
    for (const k of keys) {
      const targetClean = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = rowKeys.find((rk) => {
        const rkClean = rk.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return rkClean === targetClean;
      });
      if (match && row[match] !== undefined && row[match] !== null && String(row[match]).trim() !== '') {
        return String(row[match]).replace(/^\uFEFF/, '').trim();
      }
    }
    return '';
  };

  const name = getVal('name', 'productname', 'itemname', 'product', 'item', 'title', 'description', 'itemdescription', 'productdescription');
  const regionalName = getVal('regionalName', 'regionalname', 'printname', 'localname', 'tamilname', 'regional', 'displayname');
  const categoryName = getVal('category', 'categoryname', 'group', 'categoryid', 'catname', 'itemcategory');

  const rawType = getVal('productType', 'producttype', 'type', 'itemtype', 'product_type', 'item_type', 'kind', 'nature') || 'standard';
  const productType = canonicalProductType(rawType);
  const productTypes = [productType];

  const unit = getVal('unit', 'uom', 'units', 'baseunit', 'unitofmeasure') || 'pcs';
  const sku = getVal('sku', 'skucode', 'itemcode', 'productcode');
  const barcode = getVal('barcode', 'code', 'upc', 'ean', 'barcodeno');
  const purchasePrice = cleanNumStr(getVal('purchasePrice', 'purchaseprice', 'costprice', 'cost', 'buyprice', 'unitcost', 'purchasecost'));
  const price = cleanNumStr(getVal('price', 'sellingprice', 'saleprice', 'rate', 'sale_price', 'mrp', 'retailprice', 'unitprice', 'sellprice', 'offerprice', 'netprice'));
  const mrp = cleanNumStr(getVal('mrp', 'maxretailprice', 'maximumretailprice'));
  const wholesalePrice = cleanNumStr(getVal('wholesalePrice', 'wholesaleprice', 'wholesale', 'wholesalerate'));
  const stock = cleanNumStr(getVal('stock', 'qty', 'quantity', 'openingstock', 'currentstock', 'stockqty', 'availableqty', 'onhand'));
  const minStock = cleanNumStr(getVal('minStock', 'minstock', 'reorderlevel', 'minimumstock', 'minqty'));
  const hsn = getVal('hsn', 'hsncode', 'sac', 'hsn_code');
  const taxRate = cleanNumStr(getVal('taxRate', 'taxrate', 'gst', 'tax', 'gstrate', 'taxpercent', 'gstpercent'));

  return {
    name,
    regionalName,
    categoryName,
    productType,
    unit,
    // Numeric-only, same as manual entry; leave blank when the imported value
    // has no digits so shapeProduct assigns the next sequential SKU itself.
    sku: cleanSku(sku),
    barcode,
    purchasePrice,
    price,
    mrp,
    wholesalePrice,
    stock,
    minStock,
    hsn,
    taxRate
  };
}

exports.bulkImportProducts = (req, res) => {
  const store = req.tenantStore;
  const { products } = req.body;
  if (!Array.isArray(products)) {
    return res.status(400).json({ success: false, message: 'Invalid product list format.' });
  }

  if (!Array.isArray(store.categories)) store.categories = [];
  if (!Array.isArray(store.products)) store.products = [];

  const errors = [];
  const added = [];
  const updated = [];

  for (let i = 0; i < products.length; i++) {
    const rawRow = products[i];
    const norm = normalizeImportRow(rawRow);

    if (!norm.name && norm.price === '' && norm.barcode === '') continue;
    if (!norm.name) {
      errors.push({ row: i + 1, name: 'N/A', message: 'Missing product name' });
      continue;
    }

    if (norm.price === '') norm.price = '0';

    try {
      // Auto-resolve or create category
      let categoryId = 'cat_1';
      if (norm.categoryName) {
        const catNameClean = norm.categoryName.trim();
        let cat = store.categories.find(
          (c) => c.name.toLowerCase() === catNameClean.toLowerCase() || c.id === catNameClean
        );
        if (!cat) {
          cat = {
            id: `cat_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: catNameClean,
            icon: '📦',
            color: '#6366f1',
            taxRate: Number(norm.taxRate) || 0,
            hsn: norm.hsn || '',
            description: `Auto-created from import of ${norm.name}`,
            createdAt: new Date().toISOString()
          };
          store.categories.push(cat);
        }
        categoryId = cat.id;
      } else if (store.categories.length) {
        categoryId = store.categories[0].id;
      }

      // Auto-register unit if missing
      if (norm.unit && Array.isArray(store.units)) {
        const cleanUnit = norm.unit.toLowerCase();
        if (!findUnit(store.units, cleanUnit)) {
          store.units.push({ name: cleanUnit, subUnit: null, factor: null, locked: false });
        }
      }

      const payload = {
        ...norm,
        categoryId
      };

      // Match existing product by barcode (if non-empty) or exact name
      let existingProduct = null;
      if (norm.barcode) {
        existingProduct = store.products.find(
          (p) => p.barcode === norm.barcode || (p.barcodes || []).includes(norm.barcode)
        );
      }
      if (!existingProduct && norm.name) {
        existingProduct = store.products.find(
          (p) => p.name.toLowerCase().trim() === norm.name.toLowerCase().trim()
        );
      }

      const oldStock = existingProduct ? existingProduct.stock : 0;
      const shaped = shapeProduct(store, payload, existingProduct, actor(req));

      if (existingProduct) {
        Object.assign(existingProduct, shaped);
        updated.push(existingProduct);

        const qtyDiff = existingProduct.stock - oldStock;
        if (qtyDiff !== 0) {
          logStockMovement(store, {
            product: existingProduct,
            type: 'ADJUSTMENT',
            qtyChange: qtyDiff,
            reason: `CSV Bulk Import Update (stock changed from ${oldStock} to ${existingProduct.stock})`,
            user: actor(req)
          });
        }
      } else {
        store.products.unshift(shaped);
        added.push(shaped);

        if (shaped.stock !== 0) {
          logStockMovement(store, {
            product: shaped,
            type: 'OPENING',
            qtyChange: shaped.stock,
            reason: 'CSV Bulk Import Initial Stock',
            user: actor(req)
          });
        }
      }
    } catch (e) {
      errors.push({ row: i + 1, name: norm.name || 'N/A', message: e.message });
    }
  }

  const affectedProducts = [...added, ...updated];
  const stockValue = affectedProducts.reduce((s, p) => s + (p.productType === 'service' ? 0 : p.stock * p.purchasePrice), 0);
  if (stockValue > 0) {
    posting.postStockAdjustment(
      store,
      { id: `bulk_${Date.now()}`, productName: `${affectedProducts.length} imported/updated products`, reason: 'Bulk CSV import/update', value: stockValue, date: new Date().toISOString() },
      { createdBy: actor(req) }
    );
  }

  const message = `Bulk import complete: ${added.length} new created, ${updated.length} updated${errors.length ? `, ${errors.length} skipped.` : '.'}`;

  res.status(200).json({
    success: true,
    message,
    summary: {
      total: products.length,
      importedCount: added.length,
      updatedCount: updated.length,
      failedCount: errors.length,
      errors
    },
    data: affectedProducts
  });
};

/* ---------------------------- Stock Analytics & Adjustments ---------------------------- */

exports.getInventorySummary = (req, res) => {
  const store = req.tenantStore;
  const products = store.products || [];
  const recipes = store.recipes || [];
  const evaluated = products.map((p) => ({
    product: p,
    status: calculateProductStock(p, products, recipes)
  }));

  const lowStock = evaluated.filter((e) => !e.status.isService && e.status.isLow).map((e) => e.product);
  const outOfStock = evaluated.filter((e) => !e.status.isService && e.status.isOut).map((e) => e.product);

  const rawProducts = products.filter((p) => (p.productTypes || [p.productType]).includes('raw'));
  const serviceProducts = products.filter((p) => p.productType === 'service');
  const comboProducts = products.filter((p) => p.productType === 'combo');
  const compositeProducts = products.filter((p) => p.productType === 'composite' || p.isComposite);

  res.json({
    success: true,
    data: {
      totalProducts: products.length,
      rawCount: rawProducts.length,
      serviceCount: serviceProducts.length,
      comboCount: comboProducts.length,
      compositeCount: compositeProducts.length,
      totalUnits: products.reduce((s, p) => s + (p.productType === 'service' ? 0 : p.stock), 0),
      stockValueAtCost: Math.round(products.reduce((s, p) => s + (p.productType === 'service' ? 0 : p.stock * p.purchasePrice), 0)),
      stockValueAtRetail: Math.round(products.reduce((s, p) => s + (p.productType === 'service' ? 0 : p.stock * p.price), 0)),
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      lowStockItems: evaluated
        .filter((e) => !e.status.isService && e.status.isLow)
        .sort((a, b) => a.status.stock - b.status.stock)
        .slice(0, 25)
        .map((e) => ({
          id: e.product.id,
          name: e.product.name,
          regionalName: e.product.regionalName,
          stock: e.status.stock,
          minStock: e.product.minStock,
          unit: e.product.unit,
          isComposite: e.status.isComposite,
          isCombo: e.status.isCombo
        }))
    }
  });
};

exports.adjustStock = (req, res) => {
  const store = req.tenantStore;
  const { productId, mode, quantity, reason, password, warehouseId, batchId, batchNo, serial, serials } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  if (store.settings.pos.requirePasswordForStockEdit && password !== store.settings.pos.stockEditPassword) {
    return res.status(403).json({ success: false, code: 'STOCK_PASSWORD_INVALID', message: 'Incorrect stock-edit password.' });
  }

  const rawQty = Number(quantity);
  if (!Number.isFinite(rawQty)) {
    return res.status(400).json({ success: false, message: 'A numeric quantity is required.' });
  }
  if (rawQty % 1 !== 0 && isWholeNumberUnit(product.unit)) {
    return res.status(400).json({ success: false, message: `${product.name} is tracked in ${product.unit} — adjustment quantity must be a whole number.` });
  }
  const qty = rawQty;
  const previous = num(product.stock, 0);

  // 1. Resolve Godown / Warehouse
  const targetWh = (store.warehouses || []).find((w) => w.id === warehouseId)
    || (store.warehouses || []).find((w) => w.isDefault)
    || (store.warehouses || [])[0]
    || { id: 'wh_shop', name: 'Main Godown' };
  const whKey = targetWh.id;

  if (!product.warehouses || typeof product.warehouses !== 'object') {
    product.warehouses = {};
    if (previous > 0) {
      product.warehouses[whKey] = previous;
    }
  }

  const prevWhStock = num(product.warehouses[whKey], 0);
  const newWhStock = mode === 'SET' ? qty : mode === 'REMOVE' ? prevWhStock - qty : prevWhStock + qty;

  if (newWhStock < 0 && !store.settings.pos?.allowNegativeStock) {
    return res.status(400).json({ success: false, message: `Stock in ${targetWh.name} cannot be negative (${newWhStock}).` });
  }

  product.warehouses[whKey] = Math.max(0, newWhStock);

  if (Object.keys(product.warehouses).length > 0) {
    product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + num(val, 0), 0);
  } else {
    product.stock = mode === 'SET' ? qty : mode === 'REMOVE' ? previous - qty : previous + qty;
  }

  if (product.stock < 0 && !store.settings.pos?.allowNegativeStock) {
    product.warehouses[whKey] = prevWhStock;
    product.stock = previous;
    return res.status(400).json({ success: false, message: 'Negative stock is not allowed for this store.' });
  }

  const delta = product.stock - previous;

  // 2. Batch Update
  let appliedBatchNo = (batchNo || '').trim();
  if (batchId || appliedBatchNo) {
    if (!Array.isArray(product.batches)) product.batches = [];
    let targetBatch = product.batches.find((b) => b.id === batchId || (appliedBatchNo && String(b.batchNo).toLowerCase() === appliedBatchNo.toLowerCase()));
    if (targetBatch) {
      appliedBatchNo = targetBatch.batchNo;
      const prevBQty = Number(targetBatch.qty) || 0;
      targetBatch.qty = mode === 'SET' ? qty : mode === 'REMOVE' ? Math.max(0, prevBQty - qty) : prevBQty + qty;
      if (whKey) targetBatch.warehouseId = whKey;
    } else if (appliedBatchNo && mode !== 'REMOVE') {
      targetBatch = {
        id: `b_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        batchNo: appliedBatchNo,
        qty: qty,
        warehouseId: whKey,
        costPrice: product.purchasePrice || 0,
        sellPrice: product.price || 0,
        createdAt: new Date().toISOString()
      };
      product.batches.push(targetBatch);
      product.trackBatches = true;
    }
  }

  // 3. Serial Numbers Update
  const inputSerials = Array.isArray(serials)
    ? serials
    : (serial ? String(serial).split(',').map((s) => s.trim()).filter(Boolean) : []);

  if (inputSerials.length > 0) {
    if (!Array.isArray(product.serialNumbers)) product.serialNumbers = [];
    if (mode === 'ADD') {
      inputSerials.forEach((sn) => {
        if (!product.serialNumbers.includes(sn)) product.serialNumbers.push(sn);
      });
    } else if (mode === 'REMOVE') {
      product.serialNumbers = product.serialNumbers.filter((sn) => !inputSerials.includes(sn));
    } else if (mode === 'SET') {
      product.serialNumbers = [...inputSerials];
    }
  }

  // 4. Detailed Reason and Stock Movement Log
  const details = [];
  if (reason) details.push(reason);
  if (targetWh?.name) details.push(`Godown: ${targetWh.name}`);
  if (appliedBatchNo) details.push(`Batch: ${appliedBatchNo}`);
  if (inputSerials.length > 0) details.push(`Serial(s): ${inputSerials.join(', ')}`);
  const fullReason = details.join(' · ');

  const movement = logStockMovement(store, {
    product,
    type: 'ADJUSTMENT',
    qtyChange: delta,
    reason: fullReason,
    user: actor(req),
    warehouseId: whKey,
    warehouseName: targetWh?.name,
    batchNo: appliedBatchNo || null,
    serials: inputSerials
  });

  const voucher = posting.postStockAdjustment(
    store,
    {
      id: movement.id,
      productName: product.name,
      reason: fullReason,
      value: delta * (product.purchasePrice || 0),
      date: movement.date
    },
    { createdBy: actor(req) }
  );

  res.json({
    success: true,
    message: `Stock adjusted from ${previous} to ${product.stock} ${product.unit} in ${targetWh.name}.`,
    data: { product, movement, voucherNo: voucher ? voucher.voucherNo : null }
  });
};

/** Writes off a quantity from one batch (expired/damaged/etc.) and logs it like any other stock adjustment. */
exports.writeOffBatch = (req, res) => {
  const store = req.tenantStore;
  const { productId, batchId, quantity, reason } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  if (!product.trackBatches) {
    return res.status(400).json({ success: false, message: 'This product is not batch-tracked.' });
  }

  let record;
  try {
    record = writeOffBatch(product, batchId, Number(quantity), reason, actor(req));
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const movement = logStockMovement(store, {
    product,
    type: 'WRITE_OFF',
    qtyChange: -record.qty,
    reason: `Batch ${record.batchNo} written off: ${record.reason}`,
    user: actor(req)
  });

  let voucher = null;
  try {
    voucher = posting.postStockAdjustment(
      store,
      {
        id: movement.id,
        productName: product.name,
        reason: `Batch write-off (${record.reason}): ${product.name} / ${record.batchNo}`,
        value: record.costValue,
        date: movement.date
      },
      { createdBy: actor(req) }
    );
  } catch (err) {
    // Accounting posting is best-effort — the stock write-off itself already succeeded.
  }

  if (!Array.isArray(store.batchWriteOffs)) store.batchWriteOffs = [];
  store.batchWriteOffs.unshift(record);

  res.json({
    success: true,
    message: `Wrote off ${record.qty} ${product.unit} from batch ${record.batchNo}.`,
    data: { product, movement, writeOff: record, voucherNo: voucher ? voucher.voucherNo : null }
  });
};

/**
 * Aggregates, per batch, how much has actually sold and for how much — built
 * from `batchesSold` already recorded on each sale line (see routes/sales.js
 * `deductStock`). A line's revenue is spread across the batch(es) it drew
 * from in proportion to base-unit quantity, so alt-unit/sub-unit sales
 * (boxes, grams, etc.) still attribute correctly.
 */
exports.getBatchSalesReport = (req, res) => {
  const store = req.tenantStore;
  const agg = {};

  (store.orders || []).forEach((order) => {
    if (order.status === 'DRAFT' || order.status === 'VOID') return;
    (order.items || []).forEach((item) => {
      if (!Array.isArray(item.batchesSold) || !item.batchesSold.length) return;
      const baseQtyTotal = Number(item.baseQty) || Number(item.qty) || 0;
      const perBaseRevenue = baseQtyTotal > 0 ? (Number(item.total) || 0) / baseQtyTotal : 0;

      item.batchesSold.forEach((bs) => {
        const key = bs.batchId;
        if (!agg[key]) {
          const product = store.products.find((p) => p.id === item.id);
          agg[key] = {
            batchId: bs.batchId,
            batchNo: bs.batchNo,
            productId: item.id,
            productName: item.name,
            unit: (product && product.unit) || item.unit || 'pcs',
            qtySold: 0,
            revenue: 0,
            orderCount: 0
          };
        }
        agg[key].qtySold = Math.round((agg[key].qtySold + Number(bs.qty)) * 10000) / 10000;
        agg[key].revenue = Math.round((agg[key].revenue + Number(bs.qty) * perBaseRevenue) * 100) / 100;
        agg[key].orderCount += 1;
      });
    });
  });

  res.json({ success: true, data: Object.values(agg).sort((a, b) => b.revenue - a.revenue) });
};

/**
 * Returns stock from a batch back to the supplier it was received from
 * (traced via the batch's originating purchase). This only corrects stock —
 * it deliberately does NOT touch accounting, since guessing the right
 * debit/credit direction for a partial return risks silently corrupting the
 * vendor ledger; adjust the vendor's payable manually via Purchases/Payments
 * if this return should reduce what's owed to them.
 */
exports.returnBatchToSupplier = (req, res) => {
  const store = req.tenantStore;
  const { productId, batchId, quantity, reason } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  if (!product.trackBatches) {
    return res.status(400).json({ success: false, message: 'This product is not batch-tracked.' });
  }

  const batch = (product.batches || []).find((b) => b.id === batchId);
  if (!batch) return res.status(404).json({ success: false, message: 'Batch not found.' });

  const qty = Number(quantity);
  if (!(qty > 0) || qty > Number(batch.qty)) {
    return res.status(400).json({ success: false, message: `Enter a quantity between 0 and ${batch.qty}.` });
  }

  const purchase = batch.refPurchaseId ? (store.purchases || []).find((p) => p.id === batch.refPurchaseId) : null;
  const vendor = purchase?.vendorId ? (store.vendors || []).find((v) => v.id === purchase.vendorId) : null;

  batch.qty = Math.round((Number(batch.qty) - qty) * 10000) / 10000;
  product.stock = Math.round((product.batches || []).reduce((sum, b) => sum + (Number(b.qty) || 0), 0) * 10000) / 10000;

  const movement = logStockMovement(store, {
    product,
    type: 'RETURN',
    qtyChange: -qty,
    reason: `Returned to supplier${vendor ? ` (${vendor.name})` : ''} — Batch ${batch.batchNo}: ${reason || 'Purchase Return'}`,
    refId: purchase ? purchase.id : null,
    user: actor(req)
  });

  res.json({
    success: true,
    message: `Returned ${qty} ${product.unit} of batch ${batch.batchNo} to supplier${vendor ? ` (${vendor.name})` : ''}. Adjust the vendor's payable manually if this reduces what's owed to them.`,
    data: { product, movement, vendor: vendor ? { id: vendor.id, name: vendor.name } : null }
  });
};

exports.getStockMovements = (req, res) => {
  const store = req.tenantStore;
  const { productId, type, limit, startDate, endDate } = req.query;

  let rows = store.stockMovements || [];
  if (productId) rows = rows.filter((m) => m.productId === productId);
  if (type && type !== 'ALL') rows = rows.filter((m) => m.type === type);

  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    rows = rows.filter((m) => new Date(m.timestamp || m.date) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    rows = rows.filter((m) => new Date(m.timestamp || m.date) <= end);
  }

  res.json({ success: true, data: rows.slice(0, Number(limit) || 200) });
};
