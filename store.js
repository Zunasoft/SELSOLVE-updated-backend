/**
 * Multi-Tenant In-Memory State & Store Management.
 * Manages store cache and accounting state for active tenant sessions.
 */

const engine = require('./accounting/engine');
const posting = require('./accounting/posting');

/* ------------------------------------------------------------------ *
 * Roles & permissions — Module 11 of the SOW.
 *
 * A role is two things: which modules the user may open, and what they may do
 * once inside. `modules` drives navigation and the module-access gate;
 * the `can*` flags are the finer-grained action toggles. An individual user may
 * override any of it via `user.permissions`, which is merged over the role.
 * ------------------------------------------------------------------ */

/** Every screen a shop user can be granted, in navigation order. */
const MODULE_KEYS = [
  'dashboard',
  'billing',
  'products',
  'inventory',
  'purchases',
  'customers',
  'vendors',
  'accounts',
  'expenses',
  'reports',
  'tables',
  'settings',
  'users'
];

/** Action-level toggles, shown as the columns of the permission matrix. */
const PERMISSION_KEYS = [
  'canDiscount',
  'canVoidBill',
  'canManageStock',
  'canEditPrice',
  'canManageProducts',
  'canManageParties',
  'canRecordPurchase',
  'canAccessReports',
  'canExport',
  'canAccessSettings',
  'canManageUsers',
  'canOpenSession',
  'canCloseSession',
  'canCashInOut'
];

const moduleMap = (granted) =>
  MODULE_KEYS.reduce((acc, key) => ({ ...acc, [key]: granted === '*' || granted.includes(key) }), {});

const ROLE_PERMISSIONS = {
  /** Shop owner — everything, no ceiling. */
  OWNER: {
    all: true,
    label: 'Owner',
    modules: moduleMap('*'),
    canDiscount: true,
    maxDiscountPercent: 100,
    canVoidBill: true,
    canManageStock: true,
    canEditPrice: true,
    canManageProducts: true,
    canManageParties: true,
    canRecordPurchase: true,
    canAccessReports: true,
    canExport: true,
    canAccessSettings: true,
    canManageUsers: true,
    canOpenSession: true,
    canCloseSession: true,
    canCashInOut: true
  },

  /** Secondary Admin — runs the shop day to day, but cannot manage staff accounts. */
  ADMIN: {
    label: 'Secondary Admin',
    modules: moduleMap(MODULE_KEYS.filter((m) => m !== 'users')),
    canDiscount: true,
    maxDiscountPercent: 25,
    canVoidBill: true,
    canManageStock: true,
    canEditPrice: true,
    canManageProducts: true,
    canManageParties: true,
    canRecordPurchase: true,
    canAccessReports: true,
    canExport: true,
    canAccessSettings: true,
    canManageUsers: false,
    canOpenSession: true,
    canCloseSession: true,
    canCashInOut: true
  },

  /** Counter staff — bills, takes payment, nothing else. */
  CASHIER: {
    label: 'Cashier',
    modules: moduleMap(['dashboard', 'billing', 'customers', 'tables']),
    canDiscount: true,
    maxDiscountPercent: 10,
    canVoidBill: false,
    canManageStock: false,
    canEditPrice: false,
    canManageProducts: false,
    canManageParties: true,
    canRecordPurchase: false,
    canAccessReports: false,
    canExport: false,
    canAccessSettings: false,
    canManageUsers: false,
    canOpenSession: true,
    canCloseSession: false,
    canCashInOut: true
  }
};

// Shops provisioned before the roles were renamed still hold MANAGER users;
// it is the same authority as a Secondary Admin.
ROLE_PERMISSIONS.MANAGER = { ...ROLE_PERMISSIONS.ADMIN, label: 'Secondary Admin (Manager)' };

/** The roles the console offers when creating a user — MANAGER stays readable but hidden. */
const ASSIGNABLE_ROLES = ['OWNER', 'ADMIN', 'CASHIER'];

/**
 * A user's effective permissions: the role defaults with the user's own
 * overrides merged on top, module map included.
 */
function effectivePermissions(user) {
  const base = ROLE_PERMISSIONS[user?.role] || ROLE_PERMISSIONS.CASHIER;
  const overrides = user?.permissions || {};
  return {
    ...base,
    ...overrides,
    modules: { ...base.modules, ...(overrides.modules || {}) }
  };
}

const iso = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60000).toISOString();

function defaultSettings() {
  return {
    company: {
      name: 'Retail Store',
      address: '123 Main Street',
      city: 'City',
      state: 'State',
      pin: '600001',
      phone: '+91 9876543210',
      email: 'contact@store.com',
      gstin: '',
      currencySymbol: '₹',
      currencyCode: 'INR',
      logoUrl: ''
    },
    billing: {
      invoicePrefix: 'INV',
      nextInvoiceNo: 1001,
      taxInclusive: true,
      defaultTaxRate: 0,
      applyCess: false,
      footerNote: 'Thank you for shopping with us! Visit again.',
      terms: 'Goods once sold cannot be returned without receipt.',
      printReceiptAfterSale: true,
      autoOpenDrawerOnCash: true
    },
    tax: {
      interState: false,
      stateGstName: 'SGST',
      centralGstName: 'CGST',
      integratedGstName: 'IGST'
    },
    hardware: {
      posPrinter: { name: 'Thermal Receipt Printer', status: 'READY', paperWidth: '80mm', autoCut: true, enabled: true },
      labelPrinter: { name: 'Barcode Label Printer', status: 'READY', labelSize: '50x25mm', enabled: true },
      barcodePrinter: { name: 'Barcode Label Printer', status: 'READY', labelSize: '50x25mm', enabled: true },
      barcodeScanner: { name: 'USB / Bluetooth Barcode Scanner', status: 'READY', mode: 'HID', enabled: true },
      cashDrawer: { name: 'RJ11 Cash Drawer', status: 'CONNECTED', triggerMode: 'PRINTER', enabled: true },
      weighingScale: {
        name: 'Serial Weighing Scale',
        status: 'DISCONNECTED',
        comPort: 'COM3',
        baudRate: 9600,
        // Weight-embedded barcodes printed by a counter scale: 2xxxxx + grams.
        embeddedBarcodePrefix: '21',
        enabled: true
      },
      poleDisplay: { name: 'VFD Customer Display', status: 'READY', welcomeText: 'Welcome!', enabled: true },
      kotPrinter: { name: 'Kitchen Thermal Printer', status: 'READY', paperWidth: '80mm', enabled: false }
    },
    pos: {
      allowNegativeStock: true,
      enableLoyalty: true,
      loyaltyPointsPerHundred: 1,
      loyaltyRedeemValue: 0.5,
      loyaltyMinRedeemPoints: 50,
      quickAmountPills: [100, 200, 500, 2000],
      enableTables: false,
      kotEnabled: false,
      requirePasswordForStockEdit: false,
      stockEditPassword: ''
    }
  };
}

const DEFAULT_UNITS = [
  'pcs', 'kg', 'g', 'litre', 'ml', 'pack', 'box', 'dozen',
  'bundle', 'metre', 'plate', 'nos', 'set', 'pair', 'bag', 'carton'
];

/** Customer groups a shop starts with — Module 7 "Customer Group Allocation". */
const DEFAULT_CUSTOMER_GROUPS = [
  { id: 'grp_retail', name: 'Retail', discountPercent: 0, priceSheetId: 'ps_retail', isDefault: true },
  { id: 'grp_wholesale', name: 'Wholesale', discountPercent: 0, priceSheetId: 'ps_wholesale', isDefault: false },
  { id: 'grp_vip', name: 'VIP', discountPercent: 5, priceSheetId: 'ps_vip', isDefault: false },
  { id: 'grp_staff', name: 'Staff', discountPercent: 10, priceSheetId: null, isDefault: false }
];

function defaultWarehouses() {
  const now = new Date().toISOString();
  return [
    { id: 'wh_main', name: 'Main Warehouse (Godown)', code: 'WH-MAIN', location: 'Main Storage', isDefault: true, createdAt: now },
    { id: 'wh_shop', name: 'Shop Floor Stock', code: 'WH-SHOP', location: 'Retail Counter', isDefault: false, createdAt: now }
  ];
}

function defaultPriceSheets() {
  const now = new Date().toISOString();
  return [
    { id: 'ps_retail', name: 'Standard Retail', code: 'RETAIL', customerType: 'Retail', isActive: true, pricingMap: {}, createdAt: now },
    { id: 'ps_wholesale', name: 'Wholesale Tier', code: 'WHOLESALE', customerType: 'Wholesale', isActive: true, pricingMap: {}, createdAt: now },
    { id: 'ps_vip', name: 'VIP Special Price', code: 'VIP', customerType: 'VIP', isActive: true, pricingMap: {}, createdAt: now }
  ];
}

/**
 * The canonical shape of a tenant's working set.
 *
 * Every collection the POS writes to must be initialised here — a missing key
 * means the first `store.<key>.unshift(...)` throws, and it also means the
 * value never reaches the tenant's database, since `tenantDb` persists exactly
 * the keys listed in its collection map.
 */
function emptyStore(overrides = {}) {
  const store = {
    // catalogue
    categories: overrides.categories || [],
    products: overrides.products || [],
    units: overrides.units || [...DEFAULT_UNITS],
    priceSheets: overrides.priceSheets || defaultPriceSheets(),
    warehouses: overrides.warehouses || defaultWarehouses(),
    recipes: overrides.recipes || [],

    // parties
    customers: overrides.customers || [],
    vendors: overrides.vendors || [],
    customerGroups: overrides.customerGroups || [...DEFAULT_CUSTOMER_GROUPS],

    // trading
    orders: [],
    purchases: overrides.purchases || [],
    stockMovements: [],
    heldBills: [],
    tables: overrides.tables || [],

    // counter sessions
    sessions: [],
    session: {
      id: `ses_${Date.now()}`,
      openedAt: new Date().toISOString(),
      openedBy: 'Owner',
      status: 'open',
      openingCash: 0,
      currentCash: 0,
      cashEntries: []
    },

    // accounting — `journal` is the key the engine actually uses
    accounts: [],
    journal: [],
    voucherCounters: {},
    reconciliations: [],
    incomes: [],
    expenses: [],
    receipts: [],
    payments: [],
    transfers: [],

    settings: defaultSettings(),
    users: [
      { id: 'u_owner', name: 'Owner', role: 'OWNER', pin: '1234', status: 'active', permissions: null, createdAt: new Date().toISOString() },
      { id: 'u_admin', name: 'Secondary Admin', role: 'ADMIN', pin: '2222', status: 'active', permissions: null, createdAt: new Date().toISOString() },
      { id: 'u_cashier', name: 'Cashier 1', role: 'CASHIER', pin: '1111', status: 'active', permissions: null, createdAt: new Date().toISOString() }
    ]
  };

  engine.ensureAccounting(store);
  return store;
}

function seedAccounting(store, { openingCash = 0, openingBank = 0, bankName = 'HDFC Current Account' }) {
  if (openingCash > 0) {
    posting.postOpeningBalance(store, {
      accountId: 'acc_cash',
      amount: openingCash,
      side: 'DR',
      createdBy: 'System Seed'
    });
  }

  if (openingBank > 0) {
    let bankAcc = store.accounts.find((a) => a.code === '1120');
    if (!bankAcc) {
      bankAcc = engine.createAccount(store, {
        name: bankName,
        code: '1120',
        type: 'ASSET',
        subtype: 'BANK',
        description: 'Primary business operating bank account'
      });
    }
    posting.postOpeningBalance(store, {
      accountId: bankAcc.id,
      amount: openingBank,
      side: 'DR',
      createdBy: 'System Seed'
    });
  }
}

function logStockMovement(store, { product, type, qtyChange, reason, refId, user, timestamp }) {
  const now = new Date();
  const isoTimestamp = timestamp || now.toISOString();
  const movement = {
    id: `sm_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    timestamp: isoTimestamp,
    dateTime: new Date(isoTimestamp).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }),
    date: isoTimestamp.split('T')[0],
    time: new Date(isoTimestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    productId: product.id,
    productName: product.name,
    type,
    qtyChange,
    resultingStock: product.stock,
    unit: product.unit || 'pcs',
    reason: reason || type,
    refId: refId || null,
    user: user || 'Owner'
  };
  store.stockMovements.unshift(movement);
  if (store.stockMovements.length > 2000) store.stockMovements.pop();
  return movement;
}

/* ------------------------------------------------------------------ *
 * Clean Store Initializer for dynamic tenants
 * ------------------------------------------------------------------ */

function genericStore() {
  const store = emptyStore({
    categories: [],
    products: []
  });
  store.session.openingCash = 0;
  store.session.currentCash = 0;
  seedAccounting(store, { openingCash: 0, openingBank: 0 });
  return store;
}

/**
 * A blank working set for one request.
 *
 * Deliberately NOT cached per tenant. `tenantDb.hydrateTenantStore` fills it
 * from the tenant's own MongoDB database at the start of every request and
 * `tenantDb.persistTenantStore` writes the changes back before the response —
 * so MongoDB, not this object, is the state of the shop. Keeping one object per
 * tenant in process memory would let a read be answered from whatever the last
 * request on this instance happened to leave behind, which is exactly the
 * behaviour that made results differ between instances.
 */
function newTenantStore() {
  return genericStore();
}

/**
 * Retained for callers outside a request (scripts, migrations) that ask for a
 * store by database name. It is a fresh object every time, so it must be
 * hydrated before use.
 */
function getTenantStore(dbName) {
  if (!dbName) throw new Error('getTenantStore requires a tenant database name.');
  return newTenantStore();
}

module.exports = {
  ROLE_PERMISSIONS,
  MODULE_KEYS,
  PERMISSION_KEYS,
  ASSIGNABLE_ROLES,
  effectivePermissions,
  DEFAULT_UNITS,
  DEFAULT_CUSTOMER_GROUPS,
  getTenantStore,
  newTenantStore,
  logStockMovement,
  emptyStore,
  genericStore,
  defaultSettings,
  defaultWarehouses,
  defaultPriceSheets
};
