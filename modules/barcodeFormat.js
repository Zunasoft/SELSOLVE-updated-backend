/**
 * Weight-embedded barcode format — ONE shared shape for the whole store (`store.settings.barcodeFormat`),
 * configured once in Settings → Barcode. Every weighed product prints through the same field
 * structure; only the numbers inside it differ per product:
 *   - id:    how many digits the embedded product-id gets. The actual id VALUE
 *            (`product.embeddedId`) is still per-product — generated/typed once per product, and is
 *            what decode matches against — but its length/position are fixed store-wide.
 *   - sku:   OPTIONAL — whether every weighed product's barcode also embeds its own `product.sku`
 *            digits, and how many. Off by default. Not used for matching; `id` alone identifies the
 *            product.
 *   - flag:  always 1 printed character. The letter itself (`product.weightFlag`, "W"/"P"/custom) is
 *            still per-product, since one shop can sell both weight- and piece-tracked items — only
 *            the fact that it's a single character is fixed here.
 *   - value: the weight/piece/quantity digits, scaled by 10^`precision` (precision 0 = a whole
 *            count). Same length/precision for every weighed product.
 * Decoding an unknown scan tries this one shared shape against every weighed product's own id/flag
 * in turn, rather than each product carrying its own shape.
 */
const DEFAULT_BARCODE_FORMAT = [
  { type: 'id', length: 5 },
  { type: 'sku', enabled: false, length: 5 },
  { type: 'flag', length: 1 },
  { type: 'value', length: 5, precision: 3 },
  { type: 'pieces', length: 4 }
];

const WEIGHT_UNITS = ['kg', 'kgs', 'g', 'gm', 'gms', 'gram', 'grams', 'lb', 'lbs', 'ltr', 'litre', 'l', 'ml'];

/** W = sold by weight/volume, P = sold by piece — decided by the unit. Only a custom letter saved on the product overrides it. */
function expectedFlag(product) {
  const saved = String(product?.weightFlag || '').toUpperCase();
  if (saved && saved !== 'W' && saved !== 'P') return saved;
  const unit = String(product?.unit || '').toLowerCase();
  if (!unit) return saved || 'W';
  return WEIGHT_UNITS.includes(unit) ? 'W' : 'P';
}

/**
 * Piece labels (flag P) read their count from the separate `pieces` field (a whole number), weight
 * labels from `value`. Stores saved before the split have no `pieces` row, so P falls back to `value`.
 */
function fieldsForLabelType(fields, isPiece) {
  const hasPieces = fields.some((f) => f.type === 'pieces' && (Number(f.length) || 0) > 0);
  if (isPiece && hasPieces) {
    return fields.filter((f) => f.type !== 'value').map((f) => (f.type === 'pieces' ? { type: 'value', length: f.length, precision: 0 } : f));
  }
  return fields.filter((f) => f.type !== 'pieces');
}

function getStoreBarcodeFormat(store) {
  const fields = store?.settings?.barcodeFormat;
  return Array.isArray(fields) && fields.length ? fields : DEFAULT_BARCODE_FORMAT;
}

/**
 * One decode attempt against a fixed field layout. `fields` here carries exactly ONE identifier
 * type (`id` or `sku`) — the other was already dropped by the caller, since a real scan carries one
 * identifier segment, never both back to back. Also requires the whole code to be consumed (not
 * just each field to fit) — without that, a shorter layout tried against a longer code would
 * silently read a later field's digits as an earlier field's value instead of rejecting the code.
 */
function tryDecodeOnce(fields, product, code, impliedQty = null) {
  let pos = 0;
  let hasIdentifier = false;
  let identifierChunk = '';
  let flagChunk = '';
  let valueRaw = null;
  let precision = 0;

  for (const f of fields) {
    const len = Number(f.length) || 0;
    if (!len || pos + len > code.length) return { ok: false, reason: 'LENGTH_MISMATCH' };
    const chunk = code.slice(pos, pos + len);
    pos += len;

    if (f.type === 'id') {
      hasIdentifier = true;
      identifierChunk = chunk;
      // The id segment is the product's Product ID, or its plain barcode for items without one.
      const ids = [product?.embeddedId, product?.barcode, ...(product?.barcodes || [])]
        .filter(Boolean)
        .map((v) => String(v).padStart(len, '0'));
      if (!ids.includes(chunk)) return { ok: false, reason: 'ID_MISMATCH' };
    } else if (f.type === 'sku') {
      hasIdentifier = true;
      identifierChunk = chunk;
      const expected = String(product?.sku || '').slice(-len).padStart(len, '0');
      if (!product?.sku || chunk !== expected) return { ok: false, reason: 'ID_MISMATCH' };
    } else if (f.type === 'flag') {
      flagChunk = chunk.trim().toUpperCase();
      const expected = expectedFlag(product);
      if (flagChunk !== expected) return { ok: false, reason: 'TYPE_MISMATCH' };
    } else if (f.type === 'value') {
      valueRaw = chunk;
      precision = Number(f.precision) || 0;
    }
  }

  if (pos !== code.length) return { ok: false, reason: 'LENGTH_MISMATCH' };
  // A piece label with no count digits at all means exactly 1 piece.
  if (valueRaw === null && impliedQty !== null) valueRaw = String(impliedQty);
  if (!hasIdentifier || valueRaw === null) return { ok: false, reason: 'NO_ID_FIELD' };

  const raw = Number(valueRaw);
  if (!Number.isFinite(raw)) return { ok: false, reason: 'INVALID_VALUE' };
  if (raw < 0) return { ok: false, reason: 'NEGATIVE_QUANTITY' };

  // Piece labels are a whole count (000001 = 1 piece), whatever the store's weight precision is.
  if (expectedFlag(product) === 'P') precision = 0;
  const quantity = Math.round((raw / Math.pow(10, precision)) * 1000) / 1000;
  return {
    ok: true,
    quantity,
    productCode: identifierChunk,
    barcodeType: flagChunk,
    rawValue: valueRaw,
    precision
  };
}

/**
 * Tries decoding `code` against one product, using the store's shared field shape plus this
 * product's own id/flag/sku values. Returns:
 *   - { ok: false, reason } if it doesn't match this product's id/flag/sku.
 *   - { ok: true, quantity, productCode, barcodeType, rawValue, precision } on a full match.
 *
 * A scan identifies the product by its Product ID OR its SKU — never both in the same code (that's
 * what Settings → Barcode's "OR, identified by SKU instead" preview line shows) — so when the SKU
 * field is enabled, this tries the Product-ID layout first and the SKU layout second, each with the
 * other identifier type dropped entirely rather than concatenated in.
 */
function tryDecodeForProduct(store, product, code) {
  const fields = fieldsForLabelType(getStoreBarcodeFormat(store), expectedFlag(product) === 'P');
  const hasIdField = fields.some((f) => f.type === 'id' && (Number(f.length) || 0) > 0);
  const hasSkuField = fields.some((f) => f.type === 'sku' && f.enabled !== false && (Number(f.length) || 0) > 0);

  const attempts = [];
  if (hasIdField) attempts.push(fields.filter((f) => f.type !== 'sku'));
  if (hasSkuField) attempts.push(fields.filter((f) => f.type !== 'id'));
  if (!attempts.length) attempts.push(fields.filter((f) => f.type !== 'sku'));

  // Piece items also accept the short form — identifier + flag with no count digits = 1 piece.
  const tries = attempts.map((v) => [v, null]);
  if (expectedFlag(product) === 'P') attempts.forEach((v) => tries.push([v.filter((f) => f.type !== 'value'), 1]));

  let lastFail = null;
  for (const [variant, implied] of tries) {
    const result = tryDecodeOnce(variant, product, code, implied);
    if (result.ok) return result;
    lastFail = result;
  }
  return lastFail;
}

/** Tries the store's shared format against every weighed product's own id/flag; the first that matches wins. */
function decodeBarcodeFormat(store, code) {
  const candidates = (store.products || []).filter((p) => p.requiresWeight);
  for (const product of candidates) {
    const result = tryDecodeForProduct(store, product, code);
    if (result.ok) return { product, quantity: result.quantity };
  }
  return null;
}

/**
 * Formal decode entry point matching the spec's structured shape — validates the code against
 * every weighed product's own id/flag and returns one clear result, success or failure, instead of
 * a bare product/quantity pair. Prefer this over decodeBarcodeFormat when the caller wants to show
 * the user *why* a scan was rejected (invalid length, wrong type letter, etc.) rather than just
 * "no match."
 */
function validateBarcode(store, code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Invalid barcode', reason: 'EMPTY' };
  }

  const candidates = (store.products || []).filter((p) => p.requiresWeight);
  if (!candidates.length) {
    return { valid: false, error: 'No weight-embedded products configured', reason: 'NO_CANDIDATES' };
  }

  let lastReason = 'NO_ID_FIELD';
  for (const product of candidates) {
    const result = tryDecodeForProduct(store, product, trimmed);
    if (result.ok) {
      return {
        valid: true,
        product_code: result.productCode,
        barcode_type: result.barcodeType,
        raw_value: result.rawValue,
        precision: result.precision,
        quantity: result.quantity,
        unit: product.unit,
        product
      };
    }
    lastReason = result.reason;
  }

  const messages = {
    LENGTH_MISMATCH: 'Invalid barcode length',
    ID_MISMATCH: 'Product not found',
    TYPE_MISMATCH: 'Unsupported barcode format',
    NO_ID_FIELD: 'Product not found',
    INVALID_VALUE: 'Invalid weight',
    NEGATIVE_QUANTITY: 'Invalid weight'
  };
  return { valid: false, error: messages[lastReason] || 'Invalid barcode', reason: lastReason };
}

/**
 * The write side of the same format — used when printing a weight-embedded label, or previewing
 * what a generated id will scan as. `opts.embeddedId`/`opts.weightFlag` let a preview plug in a
 * not-yet-saved id/flag before the product exists; `opts.fieldsOverride` lets Settings preview a
 * not-yet-saved store format the same way.
 *
 * A label carries exactly ONE identifier segment — never Product ID and SKU concatenated together
 * — matching how decode now reads a scan back and how Settings → Barcode's own preview already
 * frames it ("OR, identified by SKU instead" is a separate line, not extra digits tacked onto the
 * first one). Defaults to identifying by Product ID; pass `opts.identifyBy: 'sku'` for the SKU
 * variant, which only takes effect when the store's SKU field is actually enabled.
 */
function encodeBarcodeFormat(store, product, qty, opts = {}) {
  const q = Number(qty) || 0;
  const embeddedId = opts.embeddedId !== undefined ? opts.embeddedId : product?.embeddedId;
  const weightFlag = opts.weightFlag !== undefined ? opts.weightFlag : expectedFlag(product);
  const fields = fieldsForLabelType(opts.fieldsOverride || getStoreBarcodeFormat(store), String(weightFlag || '').toUpperCase() === 'P');
  const skuEnabled = fields.some((f) => f.type === 'sku' && f.enabled !== false && (Number(f.length) || 0) > 0);
  const identifyBy = opts.identifyBy === 'sku' && skuEnabled ? 'sku' : 'id';

  return fields
    .filter((f) => (identifyBy === 'sku' ? f.type !== 'id' : f.type !== 'sku'))
    .map((f) => {
      const len = Number(f.length) || 0;
      if (f.type === 'id') {
        return String(embeddedId || '').slice(-len).padStart(len, '0');
      }
      if (f.type === 'sku') {
        return String(product?.sku || '').slice(-len).padStart(len, '0');
      }
      if (f.type === 'flag') {
        return String(weightFlag || 'W').toUpperCase().padStart(len, '0').slice(-len);
      }
      if (f.type === 'value') {
        const precision = String(weightFlag || '').toUpperCase() === 'P' ? 0 : Number(f.precision) || 0;
        const raw = Math.round(q * Math.pow(10, precision));
        const maxRaw = Math.pow(10, len) - 1;
        // Clamp rather than slice(-len): a value that overflows the configured digits must never
        // silently lose its leading digit (200 at length 5 / precision 3 needs 200000 → 6 digits,
        // and slicing to the last 5 turns it into 00000 — a real, badly wrong scan of "0").
        return String(Math.min(Math.max(0, raw), maxRaw)).padStart(len, '0');
      }
      return '';
    })
    .join('');
}

/** The largest quantity a `value` field's (length, precision) pair can actually hold — beyond this, encodeBarcodeFormat clamps rather than corrupting the value. */
function maxRepresentableValue(field) {
  const len = Number(field?.length) || 0;
  const precision = Number(field?.precision) || 0;
  if (!len) return 0;
  return (Math.pow(10, len) - 1) / Math.pow(10, precision);
}

/** The largest quantity a label for this product can carry — pieces use the Piece Count digits, weight uses Weight digits. Null if the store's format has no matching field. */
function maxLabelQuantity(store, product) {
  const isPiece = expectedFlag(product) === 'P';
  const fields = fieldsForLabelType(getStoreBarcodeFormat(store), isPiece);
  const f = fields.find((x) => x.type === 'value');
  return f ? maxRepresentableValue(f) : null;
}

module.exports = {
  maxLabelQuantity,
  DEFAULT_BARCODE_FORMAT,
  expectedFlag,
  getStoreBarcodeFormat,
  decodeBarcodeFormat,
  validateBarcode,
  encodeBarcodeFormat,
  maxRepresentableValue
};
