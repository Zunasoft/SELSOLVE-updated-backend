/**
 * Warehouse Controller
 * Manages warehouses CRUD and stock transfer between Main Warehouse and Shop Floor.
 *
 * Like the catalog controller, these handlers mutate only `req.tenantStore`;
 * the tenant middleware writes it to the calling shop's own database.
 */

const { logStockMovement, defaultWarehouses } = require('../store');
const actor = (req) => req.headers['x-user-name'] || 'Owner';

function ensureWarehouses(store) {
  if (!Array.isArray(store.warehouses) || store.warehouses.length === 0) {
    store.warehouses = defaultWarehouses();
  }
  return store.warehouses;
}

exports.getWarehouses = (req, res) => {
  const store = req.tenantStore;
  const warehouses = ensureWarehouses(store);

  const data = warehouses.map((wh) => {
    let itemCounts = 0;
    let totalStock = 0;

    (store.products || []).forEach((p) => {
      const whStock = p.warehouses && p.warehouses[wh.id] !== undefined
        ? Number(p.warehouses[wh.id])
        : wh.id === 'wh_shop' || (wh.isDefault && !p.warehouses)
        ? Number(p.stock || 0)
        : 0;

      if (whStock > 0) {
        itemCounts += 1;
        totalStock += whStock;
      }
    });

    return { ...wh, itemCounts, totalStock };
  });

  res.json({ success: true, data });
};

exports.createWarehouse = async (req, res) => {
  const store = req.tenantStore;
  const warehouses = ensureWarehouses(store);
  const { name, code, location } = req.body;

  if (!name) return res.status(400).json({ success: false, message: 'Warehouse name is required.' });

  const warehouse = {
    id: `wh_${Date.now()}`,
    name,
    code: code || `WH-${Date.now().toString().slice(-4)}`,
    location: location || '',
    isDefault: false,
    createdAt: new Date().toISOString()
  };

  warehouses.push(warehouse);

  res.status(201).json({ success: true, message: 'Warehouse created.', data: warehouse });
};

exports.updateWarehouse = async (req, res) => {
  const store = req.tenantStore;
  const warehouses = ensureWarehouses(store);
  const wh = warehouses.find((w) => w.id === req.params.id);

  if (!wh) return res.status(404).json({ success: false, message: 'Warehouse not found.' });

  const { name, code, location } = req.body;
  if (name) wh.name = name;
  if (code) wh.code = code;
  if (location !== undefined) wh.location = location;

  res.json({ success: true, message: 'Warehouse updated.', data: wh });
};

exports.deleteWarehouse = async (req, res) => {
  const store = req.tenantStore;
  const warehouses = ensureWarehouses(store);

  if (warehouses.length <= 1) {
    return res.status(400).json({ success: false, message: 'At least one warehouse must remain.' });
  }

  const index = warehouses.findIndex((w) => w.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, message: 'Warehouse not found.' });

  const wh = warehouses[index];
  if (wh.isDefault) {
    return res.status(400).json({ success: false, message: 'Cannot delete the default warehouse.' });
  }

  // A warehouse still holding stock cannot go — deleting it out from under its
  // products would strand that quantity in a warehouse key no product form or
  // transfer screen can address again, while it keeps counting toward the
  // product's total stock as if it were still reachable.
  const strandedStock = (store.products || []).some(
    (p) => p.warehouses && typeof p.warehouses === 'object' && Number(p.warehouses[wh.id] || 0) > 0
  );
  if (strandedStock) {
    return res.status(400).json({
      success: false,
      message: `"${wh.name}" still holds stock. Transfer all remaining stock out of this warehouse before deleting it.`
    });
  }

  store.warehouses.splice(index, 1);

  res.json({ success: true, message: 'Warehouse deleted.' });
};

exports.transferStock = async (req, res) => {
  const store = req.tenantStore;
  ensureWarehouses(store);

  const { sourceWarehouseId, targetWarehouseId, reason } = req.body;
  let items = req.body.items;

  // Single item legacy payload support
  if (!Array.isArray(items) || items.length === 0) {
    if (req.body.productId) {
      items = [{ productId: req.body.productId, quantity: req.body.quantity }];
    }
  }

  if (!sourceWarehouseId || !targetWarehouseId) {
    return res.status(400).json({ success: false, message: 'Source and target warehouse are required.' });
  }

  if (sourceWarehouseId === targetWarehouseId) {
    return res.status(400).json({ success: false, message: 'Source and target warehouse must be different.' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one product item is required for transfer.' });
  }

  const sourceWh = store.warehouses.find((w) => w.id === sourceWarehouseId);
  const targetWh = store.warehouses.find((w) => w.id === targetWarehouseId);

  if (!sourceWh || !targetWh) {
    return res.status(404).json({ success: false, message: 'Source or target warehouse not found.' });
  }

  // Phase 1: Validate all items atomically
  const validatedItems = [];
  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx];
    if (!raw || !raw.productId) {
      return res.status(400).json({ success: false, message: `Item #${idx + 1} is missing product selection.` });
    }

    const qty = Number(raw.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: `Item #${idx + 1} quantity must be a positive number.` });
    }

    const product = (store.products || []).find((p) => p.id === raw.productId);
    if (!product) {
      return res.status(404).json({ success: false, message: `Product "${raw.productId}" not found.` });
    }

    if (!product.warehouses) {
      product.warehouses = {
        wh_main: Math.max(0, product.stock - 10),
        wh_shop: Math.min(product.stock, 10)
      };
    }

    const sourceCurrent = Number(product.warehouses[sourceWarehouseId] || 0);
    if (sourceCurrent < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock for "${product.name}" in ${sourceWh.name}. Available: ${sourceCurrent} ${product.unit || 'pcs'}, Requested: ${qty}.`
      });
    }

    validatedItems.push({ product, qty });
  }

  // Phase 2: Execute stock updates and log movements
  const results = [];
  const refId = `tr_${Date.now()}`;

  for (const { product, qty } of validatedItems) {
    const sourceCurrent = Number(product.warehouses[sourceWarehouseId] || 0);
    product.warehouses[sourceWarehouseId] = sourceCurrent - qty;
    product.warehouses[targetWarehouseId] = Number(product.warehouses[targetWarehouseId] || 0) + qty;
    product.stock = Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0);

    const movement = logStockMovement(store, {
      product,
      type: 'TRANSFER',
      qtyChange: qty,
      reason: reason ? `Transfer: ${sourceWh.name} -> ${targetWh.name} (${reason})` : `Transfer from ${sourceWh.name} to ${targetWh.name}`,
      refId,
      user: actor(req)
    });

    results.push({
      productId: product.id,
      productName: product.name,
      transferredQty: qty,
      sourceNewStock: product.warehouses[sourceWarehouseId],
      targetNewStock: product.warehouses[targetWarehouseId],
      totalStock: product.stock,
      movement
    });
  }

  res.json({
    success: true,
    message: `Successfully transferred ${results.length} product(s) from ${sourceWh.name} to ${targetWh.name}.`,
    data: {
      sourceWarehouse: sourceWh.name,
      targetWarehouse: targetWh.name,
      transferredCount: results.length,
      items: results
    }
  });
};
