
const FEATURE_CATALOG = [
  { key: 'dashboard', label: 'Shop Dashboard', group: 'Core', core: true },
  { key: 'billing', label: 'POS Billing', group: 'Core', core: true },
  { key: 'products', label: 'Product Management', group: 'Core', core: true },
  { key: 'inventory', label: 'Inventory & Stock', group: 'Core', core: true },
  // A credit sale has to be able to name and bill a customer, so this cannot be
  // withheld without breaking checkout itself.
  { key: 'customers', label: 'Customer Management', group: 'Core', core: true },

  { key: 'purchases', label: 'Purchase Management', group: 'Trading', core: true },
  { key: 'vendors', label: 'Vendor Management', group: 'Trading', core: true },
  { key: 'warehouses', label: 'Multi-Warehouse Stock', group: 'Trading', core: true },
  { key: 'priceSheets', label: 'Price Sheets', group: 'Trading', core: true },

  // Every sale, purchase and expense posts a double-entry voucher, so the
  // Accounts module is where the books for those postings live. It is not an
  // add-on — switching it off would leave a shop unable to read its own ledger.
  { key: 'accounts', label: 'Accounts & Ledgers', group: 'Finance', core: true },
  { key: 'expenses', label: 'Expense Management', group: 'Finance', core: true },
  { key: 'cashFlow', label: 'Cash Flow Tracking', group: 'Finance', core: true },

  { key: 'reports', label: 'Reports', group: 'Insight', core: true },
  { key: 'exports', label: 'PDF / Excel Export', group: 'Insight', core: true },

  // Tier-sold add-ons — the only things a plan actually withholds.
  { key: 'compositeItems', label: 'Composite Items (Recipes)', group: 'Advanced' },
  { key: 'tableMgmt', label: 'Table Management', group: 'Advanced' },
  { key: 'loyalty', label: 'Customer Loyalty Points', group: 'Advanced' },
  { key: 'multiUser', label: 'Multiple Users & Roles', group: 'Advanced' },
  { key: 'whatsapp', label: 'WhatsApp Reminders', group: 'Advanced' },
  { key: 'barcodePrinting', label: 'Barcode Label Printing', group: 'Advanced' },
  { key: 'weighingScale', label: 'Weighing Scale Integration', group: 'Advanced' }
];

const FEATURE_KEYS = FEATURE_CATALOG.map((f) => f.key);

/** Features every shop gets regardless of tier — a POS that cannot bill is not a POS. */
const CORE_FEATURES = FEATURE_CATALOG.filter((f) => f.core).map((f) => f.key);

/**
 * Fallback tier definitions, used when a plan carries no explicit feature list.
 *
 * Every tier gets the full standard POS (`CORE_FEATURES` is always added on top
 * by `normaliseFeatures`), so these lists only say which of the tier-sold
 * add-ons each plan includes.
 */
const PLAN_DEFAULTS = {
  trial: [...CORE_FEATURES, 'loyalty'],
  starter: [...CORE_FEATURES, 'loyalty', 'barcodePrinting'],
  monthly: [...CORE_FEATURES, 'loyalty', 'multiUser', 'whatsapp', 'barcodePrinting', 'weighingScale'],
  pro: [...CORE_FEATURES, 'compositeItems', 'tableMgmt', 'loyalty', 'multiUser', 'whatsapp', 'barcodePrinting', 'weighingScale'],
  yearly: FEATURE_KEYS,
  enterprise: FEATURE_KEYS
};

/* ------------------------------------------------------------------ *
 * Legacy plan upgrade
 *
 * Before this catalogue existed a plan's feature list was a short set of names
 * that predates most of the modules. Read literally, such a list now reads as
 * "this tier excludes Vendors, Accounts, Expenses, Exports…", which would strip
 * capabilities from shops that already have them. A list drawn entirely from the
 * old vocabulary is therefore treated as un-migrated and widened to the tier's
 * current default, once, with a marker so a later deliberate choice sticks.
 * ------------------------------------------------------------------ */

const LEGACY_FEATURE_KEYS = new Set([
  'billing', 'inventory', 'purchases', 'reports', 'accounts',
  'compositeItems', 'tableMgmt', 'multiUser', 'hardwareIntegration', 'exportReports'
]);

const FEATURE_SCHEMA_VERSION = 2;

const isLegacyFeatureList = (features) =>
  Array.isArray(features) && features.length > 0 && features.every((key) => LEGACY_FEATURE_KEYS.has(key));

/**
 * Bring one plan's feature list up to the current catalogue. Mutates and returns
 * the plan; safe to call on every request.
 */
function upgradePlanFeatures(plan) {
  if (!plan || plan.featureSchema === FEATURE_SCHEMA_VERSION) return plan;

  if (isLegacyFeatureList(plan.features) || !Array.isArray(plan.features) || !plan.features.length) {
    const defaults = PLAN_DEFAULTS[plan.id] || PLAN_DEFAULTS.starter;
    // Union, so anything the old list granted beyond the default survives.
    plan.features = [...new Set([...defaults, ...(plan.features || []).filter((k) => FEATURE_KEYS.includes(k))])];
  }

  plan.featureSchema = FEATURE_SCHEMA_VERSION;
  return plan;
}

/**
 * Turn any of the shapes features arrive in — a string array, a boolean map, or
 * nothing at all — into a complete `{ key: boolean }` map.
 */
function normaliseFeatures(input, planId) {
  const map = {};

  let granted;
  if (Array.isArray(input) && input.length) {
    granted = new Set(input.map(String));
  } else if (input && typeof input === 'object' && Object.keys(input).length) {
    granted = new Set(Object.entries(input).filter(([, on]) => Boolean(on)).map(([key]) => key));
  } else {
    granted = new Set(PLAN_DEFAULTS[planId] || PLAN_DEFAULTS.starter);
  }

  // Legacy aliases kept so shops provisioned before this catalogue existed keep
  // the capabilities their plan already granted them.
  if (granted.has('tables')) granted.add('tableMgmt');
  if (granted.has('composite')) granted.add('compositeItems');

  for (const key of FEATURE_KEYS) map[key] = granted.has(key);
  for (const key of CORE_FEATURES) map[key] = true;

  return map;
}

/** The feature map a plan grants, ready to stamp onto a tenant. */
const featuresForPlan = (plan, planId) =>
  normaliseFeatures(plan ? upgradePlanFeatures(plan).features : null, planId || plan?.id);

/** True when a stored map only uses names from before the catalogue existed. */
function isLegacyFeatureMap(stored) {
  if (!stored || Array.isArray(stored) || typeof stored !== 'object') return false;
  const keys = Object.keys(stored);
  return keys.length > 0 && keys.every((k) => LEGACY_FEATURE_KEYS.has(k));
}

/**
 * The definitive feature map for a shop.
 *
 * Every layer that has an opinion about what a shop may do must call this and
 * nothing else. The tab list the client hides by and the gate the server refuses
 * by are then guaranteed to agree — they previously did not, so a shop could be
 * refused a tab it was in fact allowed to open.
 *
 * A map written entirely in the pre-catalogue vocabulary is treated as
 * un-migrated and widened to the shop's tier, rather than read literally as
 * "everything invented since is denied".
 */
function resolveTenantFeatures(tenant) {
  const stored = tenant?.features;
  return normaliseFeatures(isLegacyFeatureMap(stored) ? null : stored, tenant?.plan);
}

/** True when the tenant's plan includes `key`. Unknown keys are always allowed. */
function tenantHasFeature(tenant, key) {
  if (!key || !FEATURE_KEYS.includes(key)) return true;
  if (CORE_FEATURES.includes(key)) return true;
  return Boolean(resolveTenantFeatures(tenant)[key]);
}

/**
 * Route-level gate — only the tier-sold add-ons appear here.
 *
 * The standard POS routes (billing, products, inventory, purchases, vendors,
 * parties, accounts, reports, settings) are deliberately absent: those modules
 * are core, so gating them would take away screens shops already run on.
 * The first matching prefix decides; order matters — longer prefixes first.
 */
const ROUTE_FEATURES = [
  ['/tables', 'tableMgmt'],
  ['/recipes', 'compositeItems'],
  ['/hardware/weight', 'weighingScale'],
  ['/hardware/barcode-label', 'barcodePrinting']
];

const featureForPath = (path) => {
  const match = ROUTE_FEATURES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return match ? match[1] : null;
};

/**
 * Express middleware: block a request that reaches into a feature the shop's
 * plan does not include. Read-only probes are blocked too — a hidden tab should
 * not be reachable by typing the URL.
 */
const enforcePlanFeatures = (req, res, next) => {
  const key = featureForPath(req.path);
  if (!key) return next();

  if (!tenantHasFeature(req.tenant, key)) {
    const label = FEATURE_CATALOG.find((f) => f.key === key)?.label || key;
    return res.status(403).json({
      success: false,
      code: 'FEATURE_NOT_IN_PLAN',
      feature: key,
      message: `${label} is not included in your "${req.tenant?.plan || 'current'}" plan. Contact your administrator to upgrade.`
    });
  }

  return next();
};

module.exports = {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  CORE_FEATURES,
  PLAN_DEFAULTS,
  FEATURE_SCHEMA_VERSION,
  upgradePlanFeatures,
  normaliseFeatures,
  featuresForPlan,
  isLegacyFeatureMap,
  resolveTenantFeatures,
  tenantHasFeature,
  featureForPath,
  enforcePlanFeatures
};
