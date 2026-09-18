/**
 * Serial-number tracking — opt-in per product via `product.trackSerials`,
 * for products that don't use batch/expiry tracking (electronics and other
 * individually-identifiable items). Where a batch is a slice of stock with
 * one shared quantity, a serial is the opposite: every single unit gets its
 * own record (serial number, IMEI, up to four shop-defined custom fields)
 * that stays traceable on its own from receiving through to sale.
 *
 * `product.stock` is kept in sync as the count of serials still IN_STOCK,
 * the same convention batches.js uses for `sum(batches.qty)` — nothing
 * outside this module needs to know serials exist underneath it.
 */

let _serialIdCounter = 0;
const randomId = (prefix) => `${prefix}_${Date.now()}_${(_serialIdCounter++).toString(36)}_${Math.floor(Math.random() * 1e6)}`;

const DEFAULT_CUSTOM_LABELS = ['Custom Field 1', 'Custom Field 2', 'Custom Field 3', 'Custom Field 4'];

/** Always exactly 4 label strings, falling back to the defaults for any missing/blank one. */
function shapeSerialCustomLabels(payload, existing) {
  const source = Array.isArray(payload?.serialCustomLabels)
    ? payload.serialCustomLabels
    : Array.isArray(existing?.serialCustomLabels)
    ? existing.serialCustomLabels
    : [];
  return DEFAULT_CUSTOM_LABELS.map((fallback, i) => (source[i] && String(source[i]).trim()) || fallback);
}

/** True if `serialNo` is already on file for this product, active or sold — a retired number stays retired, never reissued to a different unit. */
function isSerialNoTaken(product, serialNo, ignoreId) {
  const needle = String(serialNo || '').trim().toLowerCase();
  if (!needle) return false;
  return (product.serials || []).some(
    (s) => s.id !== ignoreId && String(s.serialNo || '').trim().toLowerCase() === needle
  );
}

/**
 * Recomputes `product.stock` as the count of serials still in stock. Sold
 * serials stay in the array (that's the whole point — traceability doesn't
 * end at the sale) but stop counting toward on-hand quantity.
 */
function recomputeSerialStock(product) {
  product.stock = (product.serials || []).filter((s) => s.status !== 'SOLD').length;
}

/**
 * Normalizes the `serials` array on an incoming product payload. Manually
 * entered serial numbers are capped at 10 digits and resolved in one
 * left-to-right pass so two rows can never collide — a duplicate (or a
 * blank, left for auto-assignment) falls through to the next free number,
 * mirroring shapeBatches' collision handling.
 */
function shapeSerials(payload, existing) {
  const source = Array.isArray(payload?.serials) ? payload.serials : existing?.serials;
  if (!Array.isArray(source)) return existing?.serials || [];

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
    .filter((s) => s)
    .map((s) => {
      const manual = s.serialNo ? String(s.serialNo).trim().replace(/\s+/g, '').slice(0, 10) : '';
      let serialNo;
      if (manual && !used.has(manual)) {
        serialNo = manual;
      } else {
        serialNo = nextAuto();
      }
      used.add(serialNo);

      const customFields = Array.isArray(s.customFields)
        ? [0, 1, 2, 3].map((i) => (s.customFields[i] !== undefined && s.customFields[i] !== null ? String(s.customFields[i]) : ''))
        : ['', '', '', ''];

      return {
        id: s.id || randomId('serial'),
        serialNo,
        imei: s.imei ? String(s.imei).trim().slice(0, 20) : '',
        customFields,
        status: s.status === 'SOLD' ? 'SOLD' : 'IN_STOCK',
        warehouseId: s.warehouseId || 'wh_main',
        refPurchaseId: s.refPurchaseId || null,
        soldOrderId: s.soldOrderId || null,
        createdAt: s.createdAt || new Date().toISOString()
      };
    });
}

/** Marks one serial as sold (billing) — used when a serial-tracked line is invoiced. */
/** Warranty end date from a start date + a product's configured duration (defaults to months). */
function computeWarrantyEnd(startDate, durationValue, durationUnit) {
  const value = Number(durationValue);
  if (!value || value <= 0) return null;
  const end = new Date(startDate);
  if (Number.isNaN(end.getTime())) return null;
  const unit = String(durationUnit || 'months').toLowerCase();
  if (unit === 'days') end.setDate(end.getDate() + value);
  else if (unit === 'years') end.setFullYear(end.getFullYear() + value);
  else end.setMonth(end.getMonth() + value);
  return end.toISOString();
}

/**
 * Picks which serial a sale actually draws from: the cashier's choice if
 * it's still available, otherwise the oldest-received unit still in stock
 * (FIFO — serials don't expire the way batches do, so "oldest first" is the
 * only ordering that makes sense without a cashier's preference).
 */
function pickSerialForSale(product, preferredSerialId) {
  const pool = (product.serials || []).filter((s) => s.status !== 'SOLD');
  if (preferredSerialId) {
    const found = pool.find((s) => s.id === preferredSerialId);
    if (found) return found;
  }
  return [...pool].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0] || null;
}

/**
 * Marks a serial sold at checkout. If the product has warranty enabled, the
 * warranty window is stamped starting from the sale itself — a unit sitting
 * on the shelf isn't "under warranty" yet, the clock starts when it's
 * actually billed to a customer.
 */
function markSerialSold(product, serialId, orderId, saleDate) {
  const serial = (product.serials || []).find((s) => s.id === serialId && s.status !== 'SOLD');
  if (!serial) return null;
  serial.status = 'SOLD';
  serial.soldOrderId = orderId || null;
  if (product.hasWarranty) {
    const start = saleDate ? new Date(saleDate) : new Date();
    serial.warrantyStartDate = start.toISOString();
    serial.warrantyEndDate = computeWarrantyEnd(start, product.warrantyDurationValue, product.warrantyDurationUnit);
  }
  recomputeSerialStock(product);
  return serial;
}

/** Reverses a sale (void/return) — puts the serial back into stock and clears its warranty window (it never really started). */
function restoreSerial(product, serialId) {
  const serial = (product.serials || []).find((s) => s.id === serialId);
  if (!serial) return null;
  serial.status = 'IN_STOCK';
  serial.soldOrderId = null;
  serial.warrantyStartDate = null;
  serial.warrantyEndDate = null;
  recomputeSerialStock(product);
  return serial;
}

module.exports = {
  DEFAULT_CUSTOM_LABELS,
  shapeSerialCustomLabels,
  isSerialNoTaken,
  recomputeSerialStock,
  shapeSerials,
  computeWarrantyEnd,
  pickSerialForSale,
  markSerialSold,
  restoreSerial
};
