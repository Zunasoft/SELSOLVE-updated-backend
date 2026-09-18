/**
 * Units that count discrete, indivisible items — as opposed to weight/volume/
 * length units (kg, g, litre, ml, metre) which are naturally fractional.
 * "1.5 pcs" or "2.3 boxes" doesn't mean anything on a shop floor, so these
 * stay whole numbers everywhere a quantity is entered: Add Product stock,
 * purchase receiving lines, stock adjustments and billing.
 */
const WHOLE_NUMBER_UNITS = new Set([
  'pcs', 'nos', 'pack', 'box', 'dozen', 'bundle', 'plate', 'set', 'pair', 'bag', 'carton'
]);

function isWholeNumberUnit(unit) {
  return WHOLE_NUMBER_UNITS.has(String(unit || '').toLowerCase().trim());
}

/** Rounds a quantity to a whole number when it's denominated in a whole-number unit; passes decimal-friendly units through unchanged. */
function enforceQtyPrecision(unit, qty) {
  const n = Number(qty) || 0;
  return isWholeNumberUnit(unit) ? Math.round(n) : n;
}

/**
 * Converts a quantity billed/received in an alternate unit back to a
 * product's base unit — one "box" of a product whose box factor is 12 takes
 * 12 pieces off (or onto) the shelf. Shared by sales (deducting stock) and
 * purchases (adding stock), so a bill printed in boxes and a purchase
 * received in boxes both stay in agreement with a stock report counted in
 * pieces.
 */
function baseQty(product, item) {
  const qty = Number(item.qty) || 0;
  const soldUnit = String(item.saleUnit || item.unit || '').toLowerCase().trim();
  const prodUnit = String(product?.unit || '').toLowerCase().trim();

  if (!soldUnit || !prodUnit || soldUnit === prodUnit) return qty;

  // 1. Explicit unitFactor passed on the line (e.g. 0.001 for grams when base is kg)
  if (Number(item.unitFactor) > 0) {
    return qty * Number(item.unitFactor);
  }

  // 2. Look up in product's altUnits
  const alt = (product.altUnits || []).find(
    (u) => String(u.unit).toLowerCase() === soldUnit
  );
  if (alt && Number(alt.factor) > 0) {
    return qty * Number(alt.factor);
  }

  // 3. Look up in product's customSubUnit
  const subName = String(product.customSubUnitName || '').toLowerCase().trim();
  const subFactor = Number(product.customSubUnitFactor) || 0;
  if (subName && subName === soldUnit && subFactor > 0) {
    return qty / subFactor; // e.g. 500 g with subFactor 1000 => 500 / 1000 = 0.5 kg
  }

  // 4. Standard conversions fallback
  if (prodUnit === 'kg' && (soldUnit === 'g' || soldUnit === 'gm' || soldUnit === 'grams')) {
    return qty / 1000;
  }
  if ((prodUnit === 'g' || prodUnit === 'gm') && soldUnit === 'kg') {
    return qty * 1000;
  }
  if ((prodUnit === 'ltr' || prodUnit === 'liter' || prodUnit === 'litre') && (soldUnit === 'ml' || soldUnit === 'milliliter')) {
    return qty / 1000;
  }
  if (prodUnit === 'dozen' && soldUnit === 'pcs') {
    return qty / (subFactor || 12);
  }
  if ((prodUnit === 'box' || prodUnit === 'carton') && soldUnit === 'pcs') {
    return qty / (subFactor || 12);
  }

  return qty;
}

module.exports = { baseQty, isWholeNumberUnit, enforceQtyPrecision, WHOLE_NUMBER_UNITS };
