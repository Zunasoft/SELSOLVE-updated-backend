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

const { logStockMovement, DEFAULT_UNITS, defaultPriceSheets } = require('../store');
const posting = require('../accounting/posting');
const { setRecipe, removeRecipe, decorateRecipe, recipeFromProductPayload } = require('../modules/recipes');

const actor = (req) => req.headers['x-user-name'] || 'Owner';
const num = (v, fallback = 0) => (v === undefined || v === null || v === '' ? fallback : Number(v));
const randomBarcode = () => Math.floor(1000000000 + Math.random() * 9000000000).toString();

/**
 * Alternate units — Module 4 "Multiple Units".
 *
 * A product is stocked in one base unit; everything else is a conversion from
 * it. A box of 12 pieces sells as one line at 12× the piece rate and takes 12
 * off stock, so the factor is what the billing screen multiplies by.
 */
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
      // Blank price means "base price × factor", which is the common case.
      price: u.price === undefined || u.price === '' ? null : Number(u.price),
      barcode: u.barcode ? String(u.barcode).trim() : '',
      isDefaultSaleUnit: Boolean(u.isDefaultSaleUnit)
    }));
}

function getTenantUnits(store) {
  if (!Array.isArray(store.units) || store.units.length === 0) {
    store.units = [...DEFAULT_UNITS];
  }
  return store.units;
}

function getTenantPriceSheets(store) {
  if (!Array.isArray(store.priceSheets) || store.priceSheets.length === 0) {
    store.priceSheets = defaultPriceSheets();
  }
  return store.priceSheets;
}

function shapeProduct(store, payload, existing = null, updatedBy = 'Owner') {
  const barcode = payload.barcode || existing?.barcode || payload.defaultBarcode || randomBarcode();

  let barcodes = [];
  if (Array.isArray(payload.barcodes) && payload.barcodes.length) {
    barcodes = [...new Set(payload.barcodes.map((b) => String(b).trim()).filter(Boolean))];
  } else if (typeof payload.barcodes === 'string' && payload.barcodes.trim()) {
    barcodes = [...new Set(payload.barcodes.split(',').map((b) => b.trim()).filter(Boolean))];
  } else if (existing?.barcodes?.length) {
    barcodes = [...existing.barcodes];
  } else {
    barcodes = [barcode];
  }

  if (!barcodes.includes(barcode)) barcodes.unshift(barcode);

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

  const productType = payload.productType || existing?.productType || (payload.isComposite ? 'composite' : 'standard');

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

  return {
    id: existing?.id || `p_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    name: payload.name ?? existing?.name ?? 'Untitled Product',
    printName: payload.regionalName ?? payload.printName ?? existing?.regionalName ?? existing?.printName ?? '',
    regionalName: payload.regionalName ?? payload.printName ?? existing?.regionalName ?? existing?.printName ?? '',
    description: payload.description ?? existing?.description ?? '',
  });

  const voucher = posting.postStockAdjustment(
    store,
    {
      id: movement.id,
      productName: product.name,
      reason: reason || 'Manual adjustment',
      value: delta * product.purchasePrice,
      date: movement.date
    },
    { createdBy: actor(req) }
  );

  res.json({
    success: true,
    message: `Stock adjusted from ${previous} to ${product.stock} ${product.unit}.`,
    data: { product, movement, voucherNo: voucher ? voucher.voucherNo : null }
  });
};

exports.getStockMovements = (req, res) => {
  const store = req.tenantStore;
  const { productId, type, limit } = req.query;

  let rows = store.stockMovements || [];
  if (productId) rows = rows.filter((m) => m.productId === productId);
  if (type && type !== 'ALL') rows = rows.filter((m) => m.type === type);

  res.json({ success: true, data: rows.slice(0, Number(limit) || 200) });
};
