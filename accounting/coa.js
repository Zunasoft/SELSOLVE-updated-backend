/**
 * Chart of Accounts — the foundation of the Selsolve accounting system.
 *
 * Every account carries:
 *   code       stable numeric code used for ordering and manual lookup
 *   type       ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
 *   isGroup    group headers hold no postings, only children
 *   systemKey  stable handle the auto-posting engine uses to find an account
 *              without depending on user-editable names
 *
 * Sign convention: every posting is stored as a raw debit/credit pair in the
 * journal. Presentation flips the sign for CR-normal accounts (see engine.js).
 */

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

// Normal (increasing) side per account type.
const NORMAL_SIDE = {
  ASSET: 'DR',
  EXPENSE: 'DR',
  LIABILITY: 'CR',
  EQUITY: 'CR',
  INCOME: 'CR'
};

// code, name, type, isGroup, parentCode, systemKey
const DEFAULT_COA = [
  // ---------------------------------------------------------------- ASSETS
  ['1000', 'Assets', 'ASSET', true, null, 'ASSETS'],
  ['1100', 'Current Assets', 'ASSET', true, '1000', 'CURRENT_ASSETS'],
  ['1110', 'Cash in Hand', 'ASSET', true, '1100', 'CASH_GROUP'],
  ['1111', 'Main Cash Counter', 'ASSET', false, '1110', 'CASH'],
  ['1120', 'Bank Accounts', 'ASSET', true, '1100', 'BANK_GROUP'],
  ['1130', 'Accounts Receivable', 'ASSET', true, '1100', 'AR'],
  ['1140', 'Stock in Hand (Inventory)', 'ASSET', false, '1100', 'INVENTORY'],
  ['1150', 'GST Input Credit', 'ASSET', true, '1100', 'GST_INPUT'],
  ['1151', 'CGST Input Credit', 'ASSET', false, '1150', 'CGST_INPUT'],
  ['1152', 'SGST Input Credit', 'ASSET', false, '1150', 'SGST_INPUT'],
  ['1153', 'IGST Input Credit', 'ASSET', false, '1150', 'IGST_INPUT'],
  ['1160', 'Advance to Suppliers', 'ASSET', false, '1100', 'ADVANCE_SUPPLIER'],
  ['1200', 'Fixed Assets', 'ASSET', true, '1000', 'FIXED_ASSETS'],
  ['1210', 'Furniture & Fixtures', 'ASSET', false, '1200', null],
  ['1220', 'Shop Equipment & Machinery', 'ASSET', false, '1200', null],
  ['1230', 'Computers & POS Hardware', 'ASSET', false, '1200', null],

  // ----------------------------------------------------------- LIABILITIES
  ['2000', 'Liabilities', 'LIABILITY', true, null, 'LIABILITIES'],
  ['2100', 'Current Liabilities', 'LIABILITY', true, '2000', 'CURRENT_LIABILITIES'],
  ['2110', 'Accounts Payable', 'LIABILITY', true, '2100', 'AP'],
  ['2120', 'GST Payable', 'LIABILITY', true, '2100', 'GST_OUTPUT'],
  ['2121', 'CGST Payable', 'LIABILITY', false, '2120', 'CGST_OUTPUT'],
  ['2122', 'SGST Payable', 'LIABILITY', false, '2120', 'SGST_OUTPUT'],
  ['2123', 'IGST Payable', 'LIABILITY', false, '2120', 'IGST_OUTPUT'],
  ['2130', 'Salary & Wages Payable', 'LIABILITY', false, '2100', 'SALARY_PAYABLE'],
  ['2140', 'Advance from Customers', 'LIABILITY', false, '2100', 'ADVANCE_CUSTOMER'],
  ['2200', 'Loans & Borrowings', 'LIABILITY', true, '2000', 'LOANS'],
  ['2210', 'Bank Loan', 'LIABILITY', false, '2200', null],
  ['2220', 'Vehicle Loan', 'LIABILITY', false, '2200', null],

  // ---------------------------------------------------------------- EQUITY
  ['3000', 'Equity', 'EQUITY', true, null, 'EQUITY'],
  ['3100', 'Capital Account', 'EQUITY', false, '3000', 'CAPITAL'],
  ['3200', 'Retained Earnings', 'EQUITY', false, '3000', 'RETAINED_EARNINGS'],
  ['3300', 'Drawings', 'EQUITY', false, '3000', 'DRAWINGS'],
  ['3900', 'Opening Balance Equity', 'EQUITY', false, '3000', 'OPENING_EQUITY'],

  // ---------------------------------------------------------------- INCOME
  ['4000', 'Income', 'INCOME', true, null, 'INCOME'],
  ['4100', 'Sales', 'INCOME', false, '4000', 'SALES'],
  ['4200', 'Sales Return', 'INCOME', false, '4000', 'SALES_RETURN'],
  ['4300', 'Other Income', 'INCOME', true, '4000', 'OTHER_INCOME'],
  ['4310', 'Interest Income', 'INCOME', false, '4300', 'INTEREST_INCOME'],
  ['4320', 'Discount Received', 'INCOME', false, '4300', 'DISCOUNT_RECEIVED'],
  ['4330', 'Scrap & Miscellaneous Income', 'INCOME', false, '4300', null],
  ['4340', 'Commission Income', 'INCOME', false, '4300', null],

  // -------------------------------------------------------------- EXPENSES
  ['5000', 'Expenses', 'EXPENSE', true, null, 'EXPENSES'],
  ['5100', 'Cost of Goods Sold', 'EXPENSE', false, '5000', 'COGS'],
  ['5150', 'Purchase Return', 'EXPENSE', false, '5000', 'PURCHASE_RETURN'],
  ['5200', 'Operating Expenses', 'EXPENSE', true, '5000', 'OPERATING_EXPENSES'],
  ['5210', 'Rent', 'EXPENSE', false, '5200', 'RENT'],
  ['5220', 'Salary & Wages', 'EXPENSE', false, '5200', 'SALARY'],
  ['5230', 'Electricity', 'EXPENSE', false, '5200', 'ELECTRICITY'],
  ['5240', 'Internet & Telephone', 'EXPENSE', false, '5200', 'INTERNET'],
  ['5250', 'Fuel & Transport', 'EXPENSE', false, '5200', 'FUEL'],
  ['5260', 'Repairs & Maintenance', 'EXPENSE', false, '5200', 'REPAIRS'],
  ['5270', 'Packing Material', 'EXPENSE', false, '5200', 'PACKING'],
  ['5280', 'Store Supplies & Consumables', 'EXPENSE', false, '5200', 'STORE_SUPPLIES'],
  ['5290', 'Marketing & Advertising', 'EXPENSE', false, '5200', 'MARKETING'],
  ['5295', 'Stock Written Off / Shrinkage', 'EXPENSE', false, '5200', 'STOCK_WRITE_OFF'],
  ['5300', 'Financial Expenses', 'EXPENSE', true, '5000', 'FINANCIAL_EXPENSES'],
  ['5310', 'Bank Charges', 'EXPENSE', false, '5300', 'BANK_CHARGES'],
  ['5320', 'Interest Expense', 'EXPENSE', false, '5300', 'INTEREST_EXPENSE'],
  ['5400', 'Discount Allowed', 'EXPENSE', false, '5000', 'DISCOUNT_ALLOWED'],
  ['5500', 'Rounding Off', 'EXPENSE', false, '5000', 'ROUNDING_OFF']
];

const accountId = (code) => `acc_${code}`;

/**
 * Materialise a fresh Chart of Accounts for a newly provisioned tenant.
 * Group accounts are marked isGroup so the posting engine rejects direct hits.
 */
function buildChartOfAccounts() {
  return DEFAULT_COA.map(([code, name, type, isGroup, parentCode, systemKey]) => ({
    id: accountId(code),
    code,
    name,
    type,
    isGroup,
    parentId: parentCode ? accountId(parentCode) : null,
    systemKey: systemKey || null,
    partyId: null,
    partyType: null,
    isSystem: true,
    isActive: true,
    description: '',
    bankDetails: null,
    createdAt: new Date().toISOString()
  }));
}

/** Cash / bank accounts are the only ones that belong in the Cash Flow statement. */
const LIQUID_SYSTEM_KEYS = ['CASH', 'BANK'];

module.exports = {
  TYPES,
  NORMAL_SIDE,
  DEFAULT_COA,
  LIQUID_SYSTEM_KEYS,
  buildChartOfAccounts,
  accountId
};
