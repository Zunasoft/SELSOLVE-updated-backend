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
    categoryId: payload.categoryId || existing?.categoryId || store.categories[0]?.id || 'cat_1',
    barcode,
    barcodes,
    defaultBarcode: barcode,
    hsn: payload.hsn ?? existing?.hsn ?? '',
    unit,
    altUnits: shapeAltUnits(payload, existing, unit),
    productType,
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
    recipeItems: Array.isArray(payload.recipeItems) ? payload.recipeItems : existing?.recipeItems || [],
    pricingHistory,
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
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Unit name is required.' });

  const clean = name.trim().toLowerCase();
  if (units.includes(clean)) return res.status(400).json({ success: false, message: 'Unit already exists.' });

  units.push(clean);
  res.status(201).json({ success: true, message: 'Unit created successfully.', data: clean });
};

exports.updateUnit = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  const oldName = req.params.oldName.toLowerCase();
  const { newName } = req.body;

  if (!newName || !newName.trim()) return res.status(400).json({ success: false, message: 'New unit name is required.' });

  const clean = newName.trim().toLowerCase();
  const index = units.indexOf(oldName);
  if (index < 0) return res.status(404).json({ success: false, message: 'Unit not found.' });

  units[index] = clean;
  (req.tenantStore.products || []).forEach((p) => {
    if (p.unit === oldName) p.unit = clean;
  });

  res.json({ success: true, message: 'Unit updated.', data: clean });
};

exports.deleteUnit = (req, res) => {
  const units = getTenantUnits(req.tenantStore);
  const name = req.params.name.toLowerCase();

  const inUse = (req.tenantStore.products || []).some((p) => p.unit === name);
  if (inUse) {
    return res.status(400).json({ success: false, message: `Cannot delete unit "${name}" because it is currently assigned to products.` });
  }

  const index = units.indexOf(name);
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
      productCount: (store.products || []).filter((p) => p.categoryId === c.id).length
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
  const inUse = (store.products || []).some((p) => p.categoryId === req.params.id);
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
  if (categoryId && categoryId !== 'all') rows = rows.filter((p) => p.categoryId === categoryId);
  if (productType && productType !== 'all') rows = rows.filter((p) => p.productType === productType);
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
    const recipe = (store.recipes || []).find((r) => r.productId === p.id);
    return { ...p, recipe: recipe ? decorateRecipe(store, recipe) : null };
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
  const { name, code, customerType, pricingMap } = req.body;

  if (!name) return res.status(400).json({ success: false, message: 'Price sheet name is required.' });

  const sheet = {
    id: `ps_${Date.now()}`,
    name,
    code: code || name.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
    customerType: customerType || 'Retail',
    isActive: true,
    pricingMap: pricingMap || {},
    createdAt: new Date().toISOString()
  };

  priceSheets.push(sheet);

  res.status(201).json({ success: true, message: 'Price sheet created.', data: sheet });
};

exports.updatePriceSheet = (req, res) => {
  const priceSheets = getTenantPriceSheets(req.tenantStore);
  const sheet = priceSheets.find((s) => s.id === req.params.id);
  if (!sheet) return res.status(404).json({ success: false, message: 'Price sheet not found.' });

  const { name, code, customerType, isActive, pricingMap } = req.body;
  if (name) sheet.name = name;
  if (code) sheet.code = code;
  if (customerType) sheet.customerType = customerType;
  if (isActive !== undefined) sheet.isActive = Boolean(isActive);
  if (pricingMap && typeof pricingMap === 'object') sheet.pricingMap = { ...sheet.pricingMap, ...pricingMap };

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
    const category = store.categories.find((c) => c.id === p.categoryId);
    const margin = p.price - p.purchasePrice;
    return {
      id: p.id,
      name: p.name,
      printName: p.printName || p.regionalName,
      regionalName: p.regionalName || p.printName,
      category: category ? category.name : '—',
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

exports.bulkImportProducts = (req, res) => {
  const store = req.tenantStore;
  const { products } = req.body;
  if (!Array.isArray(products)) {
    return res.status(400).json({ success: false, message: 'Invalid product list format.' });
  }

  const errors = [];
  const added = [];
  if (!Array.isArray(store.products)) store.products = [];

  for (let i = 0; i < products.length; i++) {
    const row = products[i];
    if (!row.name || row.price === undefined || row.price === '') {
      errors.push({ row: i + 1, name: row.name || 'N/A', message: 'Missing product name or selling price' });
      continue;
    }

    try {
      const product = shapeProduct(store, row, null, actor(req));
      store.products.unshift(product);
      added.push(product);
    } catch (e) {
      errors.push({ row: i + 1, name: row.name, message: e.message });
    }
  }

  const stockValue = added.reduce((s, p) => s + (p.productType === 'service' ? 0 : p.stock * p.purchasePrice), 0);
  if (stockValue > 0) {
    posting.postStockAdjustment(
      store,
      { id: `bulk_${Date.now()}`, productName: `${added.length} imported products`, reason: 'Bulk import', value: stockValue, date: new Date().toISOString() },
      { createdBy: actor(req) }
    );
  }

  res.status(201).json({
    success: true,
    message: `Successfully imported ${added.length} product(s)${errors.length ? `, ${errors.length} record(s) failed validation.` : '.'}`,
    summary: {
      total: products.length,
      importedCount: added.length,
      failedCount: errors.length,
      errors
    },
    data: added
  });
};

/* ---------------------------- Stock Analytics & Adjustments ---------------------------- */

exports.getInventorySummary = (req, res) => {
  const store = req.tenantStore;
  const products = store.products || [];
  const lowStock = products.filter((p) => p.productType !== 'service' && p.stock <= (p.minStock ?? 5));
  const outOfStock = products.filter((p) => p.productType !== 'service' && p.stock <= 0);

  const rawProducts = products.filter((p) => p.productType === 'raw');
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
