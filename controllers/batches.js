// Batch/lot tracking (opt-in via product.trackBatches): product.stock stays in sync as sum(batches[].qty) so the rest of the app never needs to know batches exist; consumption is FEFO (dated batches soonest-expiry-first, then undated oldest-received-first), auto-spilling into the next batch as needed.

// A timestamp + random suffix alone can collide when several batches mint in the same millisecond, silently misdirecting `.find(b => b.id === x)`; the counter rules that out.
let _batchIdCounter = 0;
const randomId = (prefix) => `${prefix}_${Date.now()}_${(_batchIdCounter++).toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// product.warehouses{} is kept as a mirror of sum(batches.qty) per warehouseId, recomputed alongside product.stock, so existing warehouse-reading code never needs to know batches exist underneath it.
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

/** True if `batchNo` is already allocated to this product (case/whitespace-insensitive), including batches that were later fully consumed or written off — the number stays "used" even once its stock hits zero. */
function isBatchNoTaken(product, batchNo, ignoreBatchId) {
  const needle = String(batchNo || '').trim().toLowerCase();
  if (!needle) return false;
  return (product.batches || []).some(
    (b) => b.id !== ignoreBatchId && String(b.batchNo || '').trim().toLowerCase() === needle
  );
}

// A counter that only ever moves forward — a void/write-off must never free up a batch number for reuse, or two different receipts could end up sharing one traceable number.
function nextAutoBatchNo(product) {
  if (!Number.isFinite(product.batchSeq)) {
    let maxNum = 0;
    (product.batches || []).forEach((b) => {
      const num = parseInt(b.batchNo, 10);
      if (!isNaN(num) && String(num) === String(b.batchNo).trim() && num > maxNum) {
        maxNum = num;
      }
    });
    product.batchSeq = maxNum;
  }
  product.batchSeq += 1;
  return String(product.batchSeq);
}

// A manually-entered batch number already on file is rejected, not silently duplicated — a repeated number would make FEFO consumption, reports and purchase history ambiguous about which lot they mean.
function addBatch(product, { batchNo, mfgDate, expiryDate, qty, costPrice, sellPrice, mrp, refPurchaseId, source, warehouseId, barcode, allowDuplicate }) {
  if (!Array.isArray(product.batches)) product.batches = [];

  let finalBatchNo = '';
  if (batchNo && String(batchNo).trim()) {
    finalBatchNo = String(batchNo).trim();
    if (!allowDuplicate && isBatchNoTaken(product, finalBatchNo)) {
      throw new Error(
        `Batch "${finalBatchNo}" has already been allocated for ${product.name || 'this product'}. Use a different batch number, or add stock to the existing batch instead.`
      );
    }
  } else {
    finalBatchNo = nextAutoBatchNo(product);
  }

  const batch = {
    id: randomId('batch'),
    batchNo: finalBatchNo,
    mfgDate: mfgDate || null,
    expiryDate: expiryDate || null,
    qty: r4(qty),
    costPrice: Number(costPrice) || 0,
    sellPrice: sellPrice !== undefined && sellPrice !== null && sellPrice !== '' ? Number(sellPrice) : null,
    // The printed MRP of this lot; blank means "use the product's MRP".
    mrp: mrp !== undefined && mrp !== null && mrp !== '' ? Number(mrp) : null,
    refPurchaseId: refPurchaseId || null,
    warehouseId: warehouseId || 'wh_main',
    source: source || 'purchase',
    // A batch's own scannable code — separate from the product's barcode, so a specific lot can be identified directly. Optional; null until generated.
    barcode: barcode ? String(barcode).trim() : null,
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

// FEFO order; a batch that moves entirely is just relabeled to the target warehouse, a partially-needed batch is split in two so each half keeps its own traceable identity.
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

// `preferredBatchId` (the cashier's pick, defaulting to soonest-expiring) is drawn from first and auto-spills into the next FEFO batch(es) if it runs short; any uncovered shortage is returned but the sale still proceeds, same as deductStock()'s non-batch convention.
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
      // Batch was deleted/written off since the sale — restore into a clearly-labeled placeholder rather than silently dropping the stock.
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

// Manual-entry batches (opening stock, corrections) are fully editable; a batch minted by a Purchase stays locked here so its qty/cost/dates never drift out of sync with the receipt that produced them — that one's corrected from the Purchase itself, or adjusted via write-off/return.
function assertEditable(batch, product) {
  if (!batch) throw new Error('Batch not found.');
  if (batch.source === 'purchase') {
    throw new Error(
      `Batch "${batch.batchNo}" was created from a Purchase and can't be edited here. Correct it from the original Purchase, or use Write Off / Return to Supplier in Batch Tracking to adjust its quantity.`
    );
  }
}

/** Edits a manually-entered batch's own fields in place. Purchase-sourced batches are rejected — see assertEditable. */
function updateBatch(product, batchId, patch) {
  if (!Array.isArray(product.batches)) product.batches = [];
  const batch = product.batches.find((b) => b.id === batchId);
  assertEditable(batch, product);

  if (patch.batchNo !== undefined) {
    const batchNo = String(patch.batchNo || '').trim();
    if (!batchNo) throw new Error('Batch number cannot be empty.');
    if (isBatchNoTaken(product, batchNo, batch.id)) {
      throw new Error(`Batch "${batchNo}" has already been allocated for ${product.name || 'this product'}.`);
    }
    batch.batchNo = batchNo;
  }
  if (patch.mfgDate !== undefined) batch.mfgDate = patch.mfgDate || null;
  if (patch.expiryDate !== undefined) batch.expiryDate = patch.expiryDate || null;
  if (patch.qty !== undefined) batch.qty = r4(patch.qty);
  if (patch.costPrice !== undefined) batch.costPrice = Number(patch.costPrice) || 0;
  if (patch.sellPrice !== undefined) {
    batch.sellPrice = patch.sellPrice !== null && patch.sellPrice !== '' ? Number(patch.sellPrice) : null;
  }
  if (patch.mrp !== undefined) {
    batch.mrp = patch.mrp !== null && patch.mrp !== '' ? Number(patch.mrp) : null;
  }
  if (patch.warehouseId !== undefined) batch.warehouseId = patch.warehouseId || 'wh_main';
  // Uniqueness of a non-blank barcode is checked by the caller (it needs the whole store, not just this product) before patch reaches here.
  if (patch.barcode !== undefined) batch.barcode = patch.barcode ? String(patch.barcode).trim() : null;

  recomputeBatchStock(product);
  return batch;
}

/** Removes a manually-entered batch entirely (not a partial write-off). Purchase-sourced batches are rejected — see assertEditable. */
function deleteBatch(product, batchId) {
  if (!Array.isArray(product.batches)) product.batches = [];
  const batch = product.batches.find((b) => b.id === batchId);
  assertEditable(batch, product);

  product.batches = product.batches.filter((b) => b.id !== batchId);
  recomputeBatchStock(product);
  return batch;
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

// Used by shapeProduct for direct edits/opening-stock entry (vs addBatch, called per purchase line). Batch numbers are resolved in one left-to-right pass tracking what's claimed, since auto-reassignment by array position could collide with another row's manually-set number.
function shapeBatches(payload, existing) {
  const source = Array.isArray(payload.batches) ? payload.batches : existing?.batches;
  if (!Array.isArray(source)) return existing?.batches || [];

  const used = new Set();
  let autoSeq = 0;
  const nextAuto = () => {
    let candidate;
    do {
      autoSeq += 1;
      candidate = String(autoSeq);
    } while (used.has(candidate));
    return candidate;
  };

  return source
    .filter((b) => b && Number(b.qty) >= 0)
    .map((b) => {
      const manual = b.batchNo && String(b.batchNo).trim();
      let batchNo;
      if (manual && !used.has(manual)) {
        // First claim wins; a later duplicate request falls through to auto-assign rather than two batches sharing one label.
        batchNo = manual;
      } else {
        batchNo = nextAuto();
      }
      used.add(batchNo);

      return {
        id: b.id || randomId('batch'),
        batchNo,
        mfgDate: b.mfgDate || null,
        expiryDate: b.expiryDate || null,
        qty: r4(b.qty),
        costPrice: Number(b.costPrice) || 0,
        sellPrice: b.sellPrice !== undefined && b.sellPrice !== null && b.sellPrice !== '' ? Number(b.sellPrice) : null,
        mrp: b.mrp !== undefined && b.mrp !== null && b.mrp !== '' ? Number(b.mrp) : null,
        refPurchaseId: b.refPurchaseId || null,
        warehouseId: b.warehouseId || 'wh_main',
        source: b.source || 'manual',
        barcode: b.barcode || null,
        createdAt: b.createdAt || new Date().toISOString()
      };
    });
}

module.exports = {
  sortBatchesFEFO,
  recomputeBatchStock,
  addBatch,
  updateBatch,
  deleteBatch,
  isBatchNoTaken,
  consumeBatchesFEFO,
  restoreBatches,
  voidPurchaseBatches,
  writeOffBatch,
  shapeBatches,
  getBatchWarehouseQty,
  transferBatchesFEFO
};
