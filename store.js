/**
 * Per-tenant in-memory store.
 *
 * Every tenant gets a fully isolated dataset keyed by its provisioned dbName,
 * mirroring the "separate database per tenant" model in the SOW. A freshly
 * provisioned tenant is bootstrapped with a full Chart of Accounts and opening
 * balance vouchers, so the books are square from the very first transaction.
 */

const { ensureAccounting, bySystemKey, ensurePartyAccount } = require('./accounting/engine');
const posting = require('./accounting/posting');

const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toISOString();

/* ------------------------------------------------------------------ *
 * Defaults shared by every tenant
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = () => ({
  company: {
    name: 'My Retail Store',
    legalName: '',
    gstin: '',
    stateCode: '33',
    address: '',
    city: '',
    state: 'Tamil Nadu',
    pincode: '',
    phone: '',
    email: '',
    website: '',
    logoUrl: '/Selsolve Logo Square.png'
  },
  billing: {
    invoicePrefix: 'INV',
    nextInvoiceNo: 1,
    currency: '₹',
    termsText: 'Goods once sold will not be taken back.',
    footerText: 'Thank you for shopping with us!',
    showGstBreakup: true,
    roundOff: true,
    printAfterCheckout: true
  },
  tax: {
    taxMode: 'EXCLUSIVE',
    defaultTaxRate: 5,
    interState: false,
    enableGst: true,
    gstScheme: 'REGULAR'
  },
  hardware: {
    printer: { enabled: true, name: 'Thermal Printer', interface: 'USB', paperWidth: '80mm', status: 'disconnected' },
    weighingScale: { enabled: true, name: 'Weighing Scale', interface: 'USB', baudRate: 9600, stableDelayMs: 600, status: 'disconnected' },
    barcodeScanner: { enabled: true, name: 'Barcode Scanner', interface: 'USB HID', prefix: '', suffix: 'Enter', status: 'disconnected' },
    barcodePrinter: { enabled: false, name: 'Label Printer', interface: 'USB', labelSize: '50x25mm', status: 'disconnected' },
    cashDrawer: { enabled: true, name: 'Cash Drawer', interface: 'Printer Kick-out', openOnCashOnly: true, status: 'disconnected' }
  },
  pos: {
    stockEditPassword: '1234',
    requirePasswordForStockEdit: true,
    allowNegativeStock: false,
    maxDiscountPercent: 20,
    receiptTemplate: 'CLASSIC',
    kotEnabled: false,
    kotPrinter: '',
    kotCategories: [],
    enableTables: false,
    enableLoyalty: true,
    loyaltyPointsPerHundred: 1
  }
});

const DEFAULT_USERS = () => [
  {
    id: 'u_owner',
    name: 'Store Owner',
    phone: '',
    email: '',
    role: 'Owner',
    pin: '1111',
    status: 'active',
    permissions: null, // Owner always has full access.
    createdAt: iso()
  }
];

const ROLE_PERMISSIONS = {
  Owner: {
    billing: true, products: true, inventory: true, purchases: true, customers: true,
    vendors: true, expenses: true, accounts: true, reports: true, settings: true,
    users: true, sessions: true, discounts: true, stockEdit: true, voidBill: true
  },
  Admin: {
    billing: true, products: true, inventory: true, purchases: true, customers: true,
    vendors: true, expenses: true, accounts: true, reports: true, settings: false,
    users: false, sessions: true, discounts: true, stockEdit: true, voidBill: true
  },
  Cashier: {
    billing: true, products: false, inventory: false, purchases: false, customers: true,
    vendors: false, expenses: false, accounts: false, reports: false, settings: false,
    users: false, sessions: true, discounts: false, stockEdit: false, voidBill: false
  }
};

const EXPENSE_CATEGORY_KEYS = [
  'RENT', 'SALARY', 'ELECTRICITY', 'INTERNET', 'FUEL', 'REPAIRS',
  'PACKING', 'STORE_SUPPLIES', 'MARKETING', 'BANK_CHARGES'
];

/* ------------------------------------------------------------------ *
 * Store shape
 * ------------------------------------------------------------------ */

function emptyStore(overrides = {}) {
  return {
    categories: [],
    products: [],
    units: ['pcs', 'kg', 'g', 'litre', 'ml', 'pack', 'box', 'dozen', 'bundle', 'metre', 'plate', 'nos', 'set', 'pair', 'bag', 'carton'],
    warehouses: [
      { id: 'wh_main', name: 'Main Warehouse (Godown)', code: 'WH-MAIN', location: 'Main Storage', isDefault: true, createdAt: iso() },
      { id: 'wh_shop', name: 'Shop Floor Stock', code: 'WH-SHOP', location: 'Retail Counter', isDefault: false, createdAt: iso() }
    ],
    priceSheets: [
      { id: 'ps_retail', name: 'Standard Retail', code: 'RETAIL', customerType: 'Retail', isActive: true, pricingMap: {} },
      { id: 'ps_wholesale', name: 'Wholesale Tier', code: 'WHOLESALE', customerType: 'Wholesale', isActive: true, pricingMap: {} },
      { id: 'ps_vip', name: 'VIP Special Price', code: 'VIP', customerType: 'VIP', isActive: true, pricingMap: {} }
    ],
    orders: [],
    heldBills: [],
    customers: [],
    vendors: [],
    purchases: [],
    expenses: [],
    incomes: [],
    receipts: [],
    payments: [],
    transfers: [],
    reconciliations: [],
    stockMovements: [],
    tables: [],
    recipes: [],
    sessions: [],
    users: DEFAULT_USERS(),
    settings: DEFAULT_SETTINGS(),
    session: {
      status: 'open',
      id: `sess_${Date.now()}`,
      openedAt: iso(),
      openedBy: 'Store Owner',
      openingCash: 0,
      currentCash: 0,
      cashEntries: []
    },
    accounts: [],
    journal: [],
    voucherCounters: {},
    ...overrides
  };
}

/**
 * Post opening vouchers so a demo/new tenant starts with a balanced set of
 * books that already reflects the cash, stock and party balances on hand.
 */
function seedAccounting(store, { openingCash = 0, openingBank = 0, bankName = 'Current Account' } = {}) {
  ensureAccounting(store);

  // A default bank ledger — POS card and UPI settlements need somewhere to land.
  if (!(store.accounts || []).some((a) => a.systemKey === 'BANK')) {
    const parent = bySystemKey(store, 'BANK_GROUP');
    const bank = {
      id: `acc_bank_${Date.now()}`,
      code: `${parent.code}-001`,
      name: bankName,
      type: 'ASSET',
      isGroup: false,
      parentId: parent.id,
      systemKey: 'BANK',
      partyId: null,
      partyType: null,
      isSystem: false,
      isActive: true,
      description: 'Primary settlement bank account',
      bankDetails: { accountNumber: '', ifsc: '', branch: '', accountType: 'Current' },
      createdAt: iso()
    };
    store.accounts.push(bank);
  }

  const openingDate = iso(30);

  if (openingCash) {
    posting.postOpeningBalance(store, {
      accountId: bySystemKey(store, 'CASH').id,
      amount: openingCash,
      side: 'DR',
      date: openingDate,
      createdBy: 'system'
    });
  }

  if (openingBank) {
    posting.postOpeningBalance(store, {
      accountId: (store.accounts || []).find((a) => a.systemKey === 'BANK').id,
      amount: openingBank,
      side: 'DR',
      date: openingDate,
      createdBy: 'system'
    });
  }

  // Stock on hand, valued at cost.
  const stockValue = (store.products || []).reduce(
    (sum, p) => sum + Number(p.purchasePrice || 0) * Number(p.stock || 0),
    0
  );
  if (stockValue > 0) {
    posting.postOpeningBalance(store, {
      accountId: bySystemKey(store, 'INVENTORY').id,
      amount: stockValue,
      side: 'DR',
      date: openingDate,
      createdBy: 'system'
    });
  }

  // Customer dues and vendor payables carried into the ledger.
  (store.customers || []).forEach((c) => {
    if (!Number(c.outstanding)) return;
    posting.postOpeningBalance(store, {
      accountId: ensurePartyAccount(store, c, 'CUSTOMER').id,
      amount: c.outstanding,
      side: 'DR',
      date: openingDate,
      createdBy: 'system'
    });
  });

  (store.vendors || []).forEach((v) => {
    if (!Number(v.outstandingPayable)) return;
    posting.postOpeningBalance(store, {
      accountId: ensurePartyAccount(store, v, 'VENDOR').id,
      amount: v.outstandingPayable,
      side: 'CR',
      date: openingDate,
      createdBy: 'system'
    });
  });

  return store;
}

/** Record every stock change so the movement log can explain any quantity. */
function logStockMovement(store, { product, type, qtyChange, reason, refId, user }) {
  if (!Array.isArray(store.stockMovements)) store.stockMovements = [];
  const movement = {
    id: `sm_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    productId: product.id,
    productName: product.name,
    type,
    qtyChange: Number(qtyChange),
    balanceAfter: Number(product.stock),
    unit: product.unit,
    reason: reason || '',
    refId: refId || null,
    user: user || 'system',
    date: new Date().toISOString()
  };
  store.stockMovements.unshift(movement);
  if (store.stockMovements.length > 2000) store.stockMovements.pop();
  return movement;
}

/* ------------------------------------------------------------------ *
 * Seeded demo tenants
 * ------------------------------------------------------------------ */

function freshMartStore() {
  const store = emptyStore({
    categories: [
      { id: 'cat_1', name: 'Fresh Fruits & Vegetables', icon: '🍎' },
      { id: 'cat_2', name: 'Dairy & Bakery', icon: '🥛' },
      { id: 'cat_3', name: 'Beverages & Soft Drinks', icon: '🥤' },
      { id: 'cat_4', name: 'Snacks & Packaged Food', icon: '🍿' },
      { id: 'cat_5', name: 'Personal Care & Household', icon: '🧼' }
    ],
    products: [
      { id: 'p_101', name: 'Fresh Organic Apples', printName: 'ஆப்பிள்', categoryId: 'cat_1', barcode: '89012345001', barcodes: ['89012345001'], hsn: '0808', unit: 'kg', price: 180, mrp: 200, purchasePrice: 120, wholesalePrice: 165, stock: 45, minStock: 10, requiresWeight: true, taxRate: 5, description: 'Grade A Himachal apples', isComposite: false },
      { id: 'p_102', name: 'Alphonso Mangoes', printName: 'மாம்பழம்', categoryId: 'cat_1', barcode: '89012345002', barcodes: ['89012345002'], hsn: '0804', unit: 'kg', price: 250, mrp: 280, purchasePrice: 160, wholesalePrice: 230, stock: 30, minStock: 8, requiresWeight: true, taxRate: 5, description: 'Ratnagiri Alphonso', isComposite: false },
      { id: 'p_103', name: 'Farm Fresh Tomatoes', printName: 'தக்காளி', categoryId: 'cat_1', barcode: '89012345003', barcodes: ['89012345003'], hsn: '0702', unit: 'kg', price: 40, mrp: 45, purchasePrice: 22, wholesalePrice: 34, stock: 85, minStock: 20, requiresWeight: true, taxRate: 0, description: '', isComposite: false },
      { id: 'p_104', name: 'Toned Milk (1 Litre)', printName: 'பால்', categoryId: 'cat_2', barcode: '89012345004', barcodes: ['89012345004'], hsn: '0401', unit: 'pack', price: 62, mrp: 62, purchasePrice: 52, wholesalePrice: 58, stock: 120, minStock: 30, requiresWeight: false, taxRate: 0, description: '', isComposite: false },
      { id: 'p_105', name: 'Amul Salted Butter 100g', printName: 'வெண்ணெய்', categoryId: 'cat_2', barcode: '89012345005', barcodes: ['89012345005'], hsn: '0405', unit: 'pcs', price: 58, mrp: 60, purchasePrice: 48, wholesalePrice: 54, stock: 65, minStock: 15, requiresWeight: false, taxRate: 5, description: '', isComposite: false },
      { id: 'p_106', name: 'Whole Wheat Bread 400g', printName: 'ரொட்டி', categoryId: 'cat_2', barcode: '89012345006', barcodes: ['89012345006'], hsn: '1905', unit: 'pcs', price: 45, mrp: 48, purchasePrice: 32, wholesalePrice: 40, stock: 40, minStock: 10, requiresWeight: false, taxRate: 0, description: '', isComposite: false },
      { id: 'p_107', name: 'Coca-Cola 750ml', printName: 'கோலா', categoryId: 'cat_3', barcode: '89012345007', barcodes: ['89012345007'], hsn: '2202', unit: 'pcs', price: 40, mrp: 45, purchasePrice: 30, wholesalePrice: 36, stock: 95, minStock: 24, requiresWeight: false, taxRate: 18, description: '', isComposite: false },
      { id: 'p_108', name: 'Lays Potato Chips 50g', printName: 'சிப்ஸ்', categoryId: 'cat_4', barcode: '89012345008', barcodes: ['89012345008'], hsn: '2005', unit: 'pcs', price: 20, mrp: 20, purchasePrice: 14, wholesalePrice: 18, stock: 150, minStock: 40, requiresWeight: false, taxRate: 12, description: '', isComposite: false }
    ],
    customers: [
      { id: 'c_1', name: 'Anand Kumar', phone: '+91 9845012345', email: '', address: '', group: 'Retail', creditLimit: 10000, outstanding: 0, loyaltyPoints: 120, createdAt: iso(60) },
      { id: 'c_2', name: 'Priya Sundaram', phone: '+91 9711098765', email: '', address: '', group: 'Retail', creditLimit: 15000, outstanding: 450, loyaltyPoints: 340, createdAt: iso(45) }
    ],
    vendors: [
      { id: 'v_1', name: 'Metro Cash & Carry Wholesale', phone: '+91 8022334455', email: '', gstin: '29AABCM1234K1Z5', address: 'Bengaluru', outstandingPayable: 12500, createdAt: iso(90) }
    ],
    tables: [
      { id: 'tbl_1', name: 'T1', area: 'Ground Floor', seats: 4, status: 'FREE', currentBillId: null, occupiedAt: null },
      { id: 'tbl_2', name: 'T2', area: 'Ground Floor', seats: 2, status: 'FREE', currentBillId: null, occupiedAt: null }
    ]
  });

  store.settings.company.name = 'FreshMart Supermarket';
  store.settings.company.gstin = '33AAFCF1234A1Z9';
  store.settings.company.city = 'Chennai';
  store.session.openingCash = 2000;
  store.session.currentCash = 2000;

  seedAccounting(store, { openingCash: 2000, openingBank: 85000, bankName: 'HDFC Current Account' });

  // A representative purchase already on the books explains the vendor payable.
  store.purchases = [
    {
      id: 'pur_1',
      vendorId: 'v_1',
      vendorName: 'Metro Cash & Carry Wholesale',
      invoiceNo: 'INV-MTR-88',
      items: [],
      subtotal: 12500,
      tax: 0,
      totalAmount: 12500,
      paymentStatus: 'UNPAID',
      date: iso(20)
    }
  ];

  return store;
}

function bakersStore() {
  const store = emptyStore({
    categories: [
      { id: 'bcat_1', name: 'Cakes & Pastries', icon: '🎂' },
      { id: 'bcat_2', name: 'Fresh Breads & Buns', icon: '🍞' },
      { id: 'bcat_3', name: 'Coffee & Beverages', icon: '☕' }
    ],
    products: [
      { id: 'bp_101', name: 'Belgian Chocolate Truffle Cake (1kg)', printName: '', categoryId: 'bcat_1', barcode: '79012345001', barcodes: ['79012345001'], hsn: '1905', unit: 'pcs', price: 750, mrp: 799, purchasePrice: 400, wholesalePrice: 690, stock: 12, minStock: 3, requiresWeight: false, taxRate: 18, description: '', isComposite: true },
      { id: 'bp_102', name: 'Red Velvet Pastry', printName: '', categoryId: 'bcat_1', barcode: '79012345002', barcodes: ['79012345002'], hsn: '1905', unit: 'pcs', price: 110, mrp: 120, purchasePrice: 55, wholesalePrice: 100, stock: 25, minStock: 6, requiresWeight: false, taxRate: 18, description: '', isComposite: false },
      { id: 'bp_201', name: 'Refined Flour (Maida)', printName: '', categoryId: 'bcat_2', barcode: '79012345010', barcodes: ['79012345010'], hsn: '1101', unit: 'kg', price: 60, mrp: 60, purchasePrice: 42, wholesalePrice: 55, stock: 80, minStock: 20, requiresWeight: true, taxRate: 5, description: 'Raw material', isComposite: false },
      { id: 'bp_202', name: 'Dark Chocolate Couverture', printName: '', categoryId: 'bcat_2', barcode: '79012345011', barcodes: ['79012345011'], hsn: '1806', unit: 'kg', price: 620, mrp: 650, purchasePrice: 450, wholesalePrice: 590, stock: 15, minStock: 4, requiresWeight: true, taxRate: 18, description: 'Raw material', isComposite: false }
    ],
    tables: [
      { id: 'btbl_1', name: 'Cafe 1', area: 'Cafe', seats: 2, status: 'FREE', currentBillId: null, occupiedAt: null },
      { id: 'btbl_2', name: 'Cafe 2', area: 'Cafe', seats: 4, status: 'FREE', currentBillId: null, occupiedAt: null }
    ],
    recipes: [
      {
        id: 'rec_1',
        productId: 'bp_101',
        productName: 'Belgian Chocolate Truffle Cake (1kg)',
        yieldQty: 1,
        ingredients: [
          { productId: 'bp_201', name: 'Refined Flour (Maida)', qty: 0.35, unit: 'kg' },
          { productId: 'bp_202', name: 'Dark Chocolate Couverture', qty: 0.4, unit: 'kg' }
        ],
        createdAt: iso(15)
      }
    ]
  });

  store.settings.company.name = "Baker's Delight Bakery";
  store.settings.pos.enableTables = true;
  store.settings.pos.kotEnabled = true;
  store.session.openingCash = 1000;
  store.session.currentCash = 1000;

  seedAccounting(store, { openingCash: 1000, openingBank: 25000, bankName: 'ICICI Current Account' });
  return store;
}

function genericStore() {
  const store = emptyStore({
    categories: [{ id: 'gen_1', name: 'General Merchandise', icon: '📦' }],
    products: [
      { id: 'gp_1', name: 'Sample Retail Item', printName: '', categoryId: 'gen_1', barcode: '1000000001', barcodes: ['1000000001'], hsn: '', unit: 'pcs', price: 100, mrp: 110, purchasePrice: 70, wholesalePrice: 92, stock: 50, minStock: 10, requiresWeight: false, taxRate: 5, description: '', isComposite: false }
    ]
  });
  store.session.openingCash = 1500;
  store.session.currentCash = 1500;
  seedAccounting(store, { openingCash: 1500, openingBank: 0 });
  return store;
}

const tenantDatabases = {
  tenant_db_freshmart: freshMartStore(),
  tenant_db_bakers: bakersStore()
};

function getTenantStore(dbName) {
  if (!tenantDatabases[dbName]) {
    tenantDatabases[dbName] = genericStore();
  }
  const store = tenantDatabases[dbName];

  // Defensive top-up: older stores keep working as new collections are added.
  const defaults = emptyStore();
  Object.keys(defaults).forEach((key) => {
    if (store[key] === undefined) store[key] = defaults[key];
  });
  ensureAccounting(store);

  return store;
}

module.exports = {
  tenantDatabases,
  getTenantStore,
  emptyStore,
  seedAccounting,
  logStockMovement,
  ROLE_PERMISSIONS,
  EXPENSE_CATEGORY_KEYS,
  DEFAULT_SETTINGS,
  iso
};
