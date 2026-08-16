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
const num = (v, fallback = 0) => {
  if (v === undefined || v === null || v === '') return fallback;
  const cleaned = String(v).replace(/[₹$,\s]/g, '');
  const val = Number(cleaned);
  return isNaN(val) ? fallback : val;
};
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

/**
 * A product can belong to more than one category — e.g. "Egg" is both a
 * sellable Product and a Raw Material used in recipes. `categoryIds` holds
 * the full set; `categoryId` (categoryIds[0]) stays the primary category so
 * existing single-category filters, reports and price sheets keep working.
 */
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
    ids = [store.categories[0]?.id || 'cat_1'];
  }
  const clean = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  return clean.length ? clean : [store.categories[0]?.id || 'cat_1'];
}

/**
 * Normalizes any string or legacy label to one of the canonical product types:
 * - standard (Standard Item)
 * - raw (Raw Material)
 * - both (Both Raw Material & Standard Product)
 * - service (Service)
 * - combo (Combo Bundle)
 * - composite (Composite / Recipe)
 */
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

/**
 * Shapes product types. Items tagged as 'both' receive ['standard', 'raw'].
 */
function shapeProductTypes(payload, existing) {
  let raw = '';
  if (payload.productType) {
    raw = payload.productType;
  } else if (Array.isArray(payload.productTypes) && payload.productTypes.length > 1) {
    raw = 'both';
  } else if (Array.isArray(payload.productTypes) && payload.productTypes.length === 1) {
    raw = payload.productTypes[0];
  } else if (typeof payload.productTypes === 'string' && payload.productTypes.trim()) {
    raw = payload.productTypes.includes(',') ? 'both' : payload.productTypes;
  } else if (existing?.productType) {
    raw = existing.productType;
  } else if (Array.isArray(existing?.productTypes) && existing.productTypes.length > 1) {
    raw = 'both';
  } else if (Array.isArray(existing?.productTypes) && existing.productTypes.length === 1) {
    raw = existing.productTypes[0];
  } else if (payload.isComposite) {
    raw = 'composite';
  }

  const type = canonicalProductType(raw);
  const types = type === 'both' ? ['standard', 'raw'] : [type];
  return types;
}

/**
 * Returns the tenant's unit definitions as an array of objects.
 * Migrates legacy flat-string arrays (`['pcs','kg',...]`) to the new
 * object format (`[{ name, subUnit, factor, locked }, ...]`) on first access.
 */
function getTenantUnits(store) {
  if (!Array.isArray(store.units) || store.units.length === 0) {
    store.units = DEFAULT_UNITS.map((u) => ({ ...u }));
    return store.units;
  }

  // Migrate: if the first element is a plain string, convert the whole array
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

/** Find a unit object by name (case-insensitive). */
function findUnit(units, name) {
  const clean = String(name).toLowerCase().trim();
  return units.find((u) => u.name === clean);
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
    barcodes,
    defaultBarcode: barcode,
    hsn: payload.hsn ?? existing?.hsn ?? '',
    unit,
    altUnits: shapeAltUnits(payload, existing, unit),
    productType,
    productTypes,
    price,
    mrp: num(payload.mrp, existing?.mrp ?? price),
    purchasePrice,
    wholesalePrice: num(payload.wholesalePrice, existing?.wholesalePrice ?? price),
    specialPrice: num(payload.specialPrice, existing?.specialPrice ?? price),
    stock: productType === 'service' ? 9999 : stock,
    minStock: num(payload.minStock, existing?.minStock ?? 5),
    warehouses,
    imageUrl: payload.imageUrl ?? existing?.imageUrl ?? '',
    requiresWeight: payload.requiresWeight !== undefined ? Boolean(payload.requiresWeight) : Boolean(existing?.requiresWeight),
    taxRate: num(payload.taxRate, existing?.taxRate ?? 0),
    isComposite: productType === 'composite' || Boolean(payload.isComposite),
    comboItems: Array.isArray(payload.comboItems) ? payload.comboItems : existing?.comboItems || [],
    customSubUnitName: payload.customSubUnitName ?? existing?.customSubUnitName ?? '',
    customSubUnitFactor: num(payload.customSubUnitFactor, existing?.customSubUnitFactor ?? 0),
    customSubUnitPrice: num(payload.customSubUnitPrice, existing?.customSubUnitPrice ?? 0),
    customSubUnitBarcode: payload.customSubUnitBarcode ?? existing?.customSubUnitBarcode ?? '',
    enableMinorUnit: payload.enableMinorUnit !== undefined ? Boolean(payload.enableMinorUnit) : Boolean(existing?.enableMinorUnit),
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : existing?.isActive ?? true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

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

exports.createCategory = async (req, res) => {
  const { name, icon, description, kotPrinter } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });

  const category = {
    id: `cat_${Date.now()}`,
    name,
    icon: icon || '📦',
    description: description || '',
    kotPrinter: kotPrinter || '',
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

  let rows = store.products || [];
  if (categoryId && categoryId !== 'all') rows = rows.filter((p) => (p.categoryIds || [p.categoryId]).includes(categoryId));
  if (productType && productType !== 'all') rows = rows.filter((p) => (p.productTypes || [p.productType]).includes(productType));
  if (status === 'active') rows = rows.filter((p) => p.isActive !== false);
  if (status === 'inactive') rows = rows.filter((p) => p.isActive === false);

  if (lowStock === 'true') rows = rows.filter((p) => p.productType !== 'service' && p.stock <= (p.minStock ?? 5));
  if (outOfStock === 'true') rows = rows.filter((p) => p.productType !== 'service' && p.stock <= 0);

  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.printName || '').toLowerCase().includes(needle) ||
        (p.regionalName || '').toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle) ||
        (p.barcodes || [p.barcode]).some((b) => String(b).includes(needle))
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
    (p) => p.barcode === needle || p.id === needle || (p.barcodes || []).includes(needle)
  );
  if (!product) return res.status(404).json({ success: false, message: 'No product matches that barcode or ID.' });
  res.json({ success: true, data: product });
};

exports.createProduct = (req, res) => {
  const store = req.tenantStore;
  if (!req.body || !req.body.name || req.body.price === undefined) {
    return res.status(400).json({ success: false, message: 'Product name and selling price are required.' });
  }

  const product = shapeProduct(store, req.body, null, actor(req));
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
  const updated = shapeProduct(store, req.body, existing, actor(req));
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
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  res.json({ success: true, data: priceSheets });
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
    createdAt: new Date().toISOString()
  };

  priceSheets.push(sheet);

  res.status(201).json({ success: true, message: 'Price sheet created.', data: sheet });
};

exports.updatePriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const sheet = priceSheets.find((s) => s.id === req.params.id);
  if (!sheet) return res.status(404).json({ success: false, message: 'Price sheet not found.' });

  const { name, code, customerType, defaultDiscountPercent, isActive, pricingMap, discountMap } = req.body;
  if (name) sheet.name = name;
  if (code) sheet.code = code;
  if (customerType) sheet.customerType = customerType;
  if (defaultDiscountPercent !== undefined) sheet.defaultDiscountPercent = Number(defaultDiscountPercent) || 0;
  if (isActive !== undefined) sheet.isActive = Boolean(isActive);
  if (pricingMap && typeof pricingMap === 'object') sheet.pricingMap = { ...pricingMap };
  if (discountMap && typeof discountMap === 'object') sheet.discountMap = { ...discountMap };

  sheet.updatedAt = new Date().toISOString();

  res.json({ success: true, message: 'Price sheet updated.', data: sheet });
};

exports.deletePriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const index = priceSheets.findIndex((s) => s.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, message: 'Price sheet not found.' });

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
      if (row[field] !== undefined && row[field] !== '') product[field] = Number(row[field]);
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
  const barcode = getVal('barcode', 'code', 'sku', 'upc', 'itemcode', 'ean', 'barcodeno');
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
  const lowStock = products.filter((p) => p.productType !== 'service' && p.stock <= (p.minStock ?? 5));
  const outOfStock = products.filter((p) => p.productType !== 'service' && p.stock <= 0);

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
      lowStockItems: lowStock
        .sort((a, b) => a.stock - b.stock)
        .slice(0, 25)
        .map((p) => ({ id: p.id, name: p.name, regionalName: p.regionalName, stock: p.stock, minStock: p.minStock, unit: p.unit }))
    }
  });
};

exports.adjustStock = (req, res) => {
  const store = req.tenantStore;
  const { productId, mode, quantity, reason, password } = req.body;

  const product = (store.products || []).find((p) => p.id === productId);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  if (store.settings.pos.requirePasswordForStockEdit && password !== store.settings.pos.stockEditPassword) {
    return res.status(403).json({ success: false, code: 'STOCK_PASSWORD_INVALID', message: 'Incorrect stock-edit password.' });
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty)) {
    return res.status(400).json({ success: false, message: 'A numeric quantity is required.' });
  }

  const previous = product.stock;
  product.stock = mode === 'SET' ? qty : mode === 'REMOVE' ? previous - qty : previous + qty;

  if (product.stock < 0 && !store.settings.pos.allowNegativeStock) {
    product.stock = previous;
    return res.status(400).json({ success: false, message: 'Negative stock is not allowed for this store.' });
  }

  const delta = product.stock - previous;
  const movement = logStockMovement(store, {
    product,
    type: 'ADJUSTMENT',
    qtyChange: delta,
    reason: reason || 'Manual stock adjustment',
    user: actor(req)
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
