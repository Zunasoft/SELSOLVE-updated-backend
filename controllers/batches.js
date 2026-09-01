/**
 * Batch/Lot tracking — opt-in per product via `product.trackBatches`.
 *
 * A batch is a slice of stock received together (one purchase line): its own
 * quantity, cost, and optional manufacture/expiry dates. `product.stock`
 * stays the single number the rest of the app already reads everywhere
 * (warehouses, recipes, price sheets, reports) — for a batch-tracked product
 * it is simply kept in sync as the sum of `product.batches[].qty` any time a
 * batch changes, so nothing outside this module needs to know batches exist.
 *
 * Consumption is FEFO (first-expiring-first-out): batches with an expiry
 * date are sold soonest-expiry-first; batches with no expiry date are sold
 * oldest-received-first, after every dated batch. A sale that needs more
 * than one batch has left automatically spills into the next one.
 */

// A timestamp + small random suffix alone can collide when several batches
// are minted in the same millisecond (e.g. splitting multiple batches across
// one warehouse transfer) — a collision would make every `.find(b => b.id
// === x)` lookup below silently target the wrong batch. The counter makes
// that impossible within this process regardless of how tight the loop is.
let _batchIdCounter = 0;
const randomId = (prefix) => `${prefix}_${Date.now()}_${(_batchIdCounter++).toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/**
 * `product.warehouses{}` is what the rest of the app (WarehousesTab, price
 * sheets, low-stock-by-warehouse filters) already reads — for a batch-tracked
 * product it's kept as a mirror of `sum(batches.qty)` per `batch.warehouseId`,
 * recomputed alongside `product.stock` any time a batch changes, so none of
 * that code needs to know batches exist underneath it.
 */
function recomputeBatchStock(product) {
  product.stock = r4((product.batches || []).reduce((sum, b) => sum + (Number(b.qty) || 0), 0));

  const map = {};
  (product.batches || []).forEach((b) => {
    const wh = b.warehouseId || 'wh_main';
    map[wh] = r4((map[wh] || 0) + (Number(b.qty) || 0));
  });
  product.warehouses = map;
}

/** Sort order used everywhere batches are offered up for consumption or display. */
function sortBatchesFEFO(batches) {
  return [...(batches || [])].sort((a, b) => {
    const aHas = !!a.expiryDate;
    const bHas = !!b.expiryDate;
    if (aHas && bHas) return new Date(a.expiryDate) - new Date(b.expiryDate);
    if (aHas !== bHas) return aHas ? -1 : 1;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
}

/**
 * Adds a new batch to a product from a purchase (or an opening-stock
 * migration). Always recomputes `product.stock` from the batch list.
 */
function addBatch(product, { batchNo, mfgDate, expiryDate, qty, costPrice, sellPrice, refPurchaseId, source, warehouseId }) {
  if (!Array.isArray(product.batches)) product.batches = [];

  let finalBatchNo = '';
  if (batchNo && String(batchNo).trim()) {
    finalBatchNo = String(batchNo).trim();
  } else {
    // Auto-generate numbers starting from 1 (or max numeric batch number + 1)
    let maxNum = 0;
    (product.batches || []).forEach((b) => {
      const num = parseInt(b.batchNo, 10);
      if (!isNaN(num) && String(num) === String(b.batchNo).trim() && num > maxNum) {
        maxNum = num;
      }
    });
    finalBatchNo = maxNum > 0 ? String(maxNum + 1) : String((product.batches || []).length + 1);
  }

  const batch = {
    id: randomId('batch'),
    batchNo: finalBatchNo,
    mfgDate: mfgDate || null,
    expiryDate: expiryDate || null,
    qty: r4(qty),
    costPrice: Number(costPrice) || 0,
    sellPrice: sellPrice !== undefined && sellPrice !== null && sellPrice !== '' ? Number(sellPrice) : null,
    refPurchaseId: refPurchaseId || null,
    warehouseId: warehouseId || 'wh_main',
    source: source || 'purchase',
    createdAt: new Date().toISOString()
  };

  product.batches.push(batch);
  recomputeBatchStock(product);
  return batch;
}

function getBatchWarehouseQty(product, warehouseId) {
  return r4(
    (product.batches || [])
      .filter((b) => (b.warehouseId || 'wh_main') === warehouseId)
      .reduce((sum, b) => sum + (Number(b.qty) || 0), 0)
  );
}

/**
 * Moves `qtyNeeded` of a batch-tracked product from one warehouse to
 * another, FEFO order. A batch that moves entirely just gets relabeled to
 * the target warehouse; a batch only partially needed is split into two
 * records (remainder stays at source, a new record lands at the target) so
 * each keeps its own traceable identity.
 */
function transferBatchesFEFO(product, sourceWarehouseId, targetWarehouseId, qtyNeeded) {
  let remaining = r4(qtyNeeded);
  const transferred = [];
  if (!Array.isArray(product.batches)) product.batches = [];

  const ordered = sortBatchesFEFO(
    product.batches.filter((b) => (b.warehouseId || 'wh_main') === sourceWarehouseId && Number(b.qty) > 0)
  );

  for (const batch of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(Number(batch.qty) || 0, remaining);
    if (take <= 0) continue;

    if (take >= Number(batch.qty)) {
      batch.warehouseId = targetWarehouseId;
    } else {
      batch.qty = r4(Number(batch.qty) - take);
      product.batches.push({
        ...batch,
        id: randomId('batch'),
        qty: take,
        warehouseId: targetWarehouseId
      });
    }
    remaining = r4(remaining - take);
    transferred.push({ batchId: batch.id, batchNo: batch.batchNo, qty: take });
  }

  recomputeBatchStock(product);
  return { transferred, shortage: remaining > 0 ? remaining : 0 };
}

/**
 * Consumes `qtyNeeded` across a product's batches, splitting across as many
 * as necessary. Mutates batch quantities and `product.stock` in place.
 * Returns which batches were drawn from (for sale-line traceability) and any
 * shortage that couldn't be covered (sale still proceeds — same convention
 * `deductStock()` already uses for non-batch shortages).
 *
 * `preferredBatchId` is the batch the cashier picked at billing (the POS
 * suggests the soonest-expiring one, but lets them choose another). It's
 * drawn from first; if it doesn't have enough on its own, the sale
 * auto-spills into the next batch(es) in FEFO order. With no preference,
 * this is plain FEFO from the start.
 */
function consumeBatchesFEFO(product, qtyNeeded, preferredBatchId) {
  let remaining = r4(qtyNeeded);
  const consumed = [];
  if (!Array.isArray(product.batches)) product.batches = [];

  const ordered = sortBatchesFEFO(product.batches).filter((b) => Number(b.qty) > 0);

  let sequence = ordered;
  if (preferredBatchId) {
    const preferred = ordered.find((b) => b.id === preferredBatchId);
    if (preferred) {
      sequence = [preferred, ...ordered.filter((b) => b.id !== preferredBatchId)];
    }
  }

  for (const batch of sequence) {
    if (remaining <= 0) break;
    const take = Math.min(Number(batch.qty) || 0, remaining);
    if (take <= 0) continue;
    batch.qty = r4(Number(batch.qty) - take);
    remaining = r4(remaining - take);
    consumed.push({ batchId: batch.id, batchNo: batch.batchNo, qty: take, expiryDate: batch.expiryDate });
  }

  recomputeBatchStock(product);
  return { consumed, shortage: remaining > 0 ? remaining : 0 };
}

/** Puts consumed quantity back into the exact batch(es) a sale drew from — used on void/delete. */
function restoreBatches(product, batchesSold) {
  if (!Array.isArray(batchesSold) || !batchesSold.length) return;
  if (!Array.isArray(product.batches)) product.batches = [];

  batchesSold.forEach(({ batchId, batchNo, qty }) => {
    const batch = product.batches.find((b) => b.id === batchId);
    if (batch) {
      batch.qty = r4(Number(batch.qty) + Number(qty));
    } else {
      // Batch itself was deleted/written off since the sale — restore into a
      // clearly-labeled placeholder rather than silently dropping the stock.
      product.batches.push({
        id: randomId('batch'),
        batchNo: batchNo || 'RESTORED',
        mfgDate: null,
        expiryDate: null,
        qty: r4(qty),
        costPrice: 0,
        sellPrice: null,
        refPurchaseId: null,
        source: 'restored',
        createdAt: new Date().toISOString()
      });
    }
  });

  recomputeBatchStock(product);
}

/** Removes the batch(es) a purchase created — used when that purchase is voided. */
function voidPurchaseBatches(product, purchaseId) {
  if (!Array.isArray(product.batches)) return;
  product.batches = product.batches.filter((b) => b.refPurchaseId !== purchaseId);
  recomputeBatchStock(product);
}

/** Writes off (damage/expiry/etc.) a quantity from one batch. Returns the write-off record. */
function writeOffBatch(product, batchId, qty, reason, user) {
  if (!Array.isArray(product.batches)) product.batches = [];
  const batch = product.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error('Batch not found.');

  const amount = Math.min(Number(batch.qty) || 0, r4(qty));
  if (amount <= 0) throw new Error('Nothing to write off.');

  batch.qty = r4(Number(batch.qty) - amount);
  recomputeBatchStock(product);

  return {
    id: randomId('writeoff'),
    productId: product.id,
    productName: product.name,
    batchId: batch.id,
    batchNo: batch.batchNo,
    qty: amount,
    costValue: r4(amount * (Number(batch.costPrice) || 0)),
    reason: reason || 'Other',
    user: user || 'Owner',
    date: new Date().toISOString()
  };
}

/**
 * Normalizes the `batches` array on an incoming product payload (used by
 * `shapeProduct` for direct edits/opening-stock entry, as opposed to
 * `addBatch`, which purchases call one line at a time).
 */
function shapeBatches(payload, existing) {
  const source = Array.isArray(payload.batches) ? payload.batches : existing?.batches;
  if (!Array.isArray(source)) return existing?.batches || [];

  let batchCounter = 0;
  return source
    .filter((b) => b && Number(b.qty) >= 0)
    .map((b) => {
      batchCounter++;
      const manual = b.batchNo && String(b.batchNo).trim();
      return {
        id: b.id || randomId('batch'),
        batchNo: manual ? String(b.batchNo).trim() : String(batchCounter),
        mfgDate: b.mfgDate || null,
        expiryDate: b.expiryDate || null,
        qty: r4(b.qty),
        costPrice: Number(b.costPrice) || 0,
        sellPrice: b.sellPrice !== undefined && b.sellPrice !== null && b.sellPrice !== '' ? Number(b.sellPrice) : null,
        refPurchaseId: b.refPurchaseId || null,
        warehouseId: b.warehouseId || 'wh_main',
        source: b.source || 'manual',
        createdAt: b.createdAt || new Date().toISOString()
      };
    });
}

module.exports = {
  sortBatchesFEFO,
  recomputeBatchStock,
  addBatch,
  consumeBatchesFEFO,
  restoreBatches,
  voidPurchaseBatches,
  writeOffBatch,
  shapeBatches,
  getBatchWarehouseQty,
  transferBatchesFEFO
};
