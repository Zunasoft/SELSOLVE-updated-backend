// Billing, held bills, counter sessions and table management — Modules 3, 17, 18 and 19 of the SOW.

const express = require('express');
const { logStockMovement } = require('../store');
const engine = require('../accounting/engine');
const posting = require('../accounting/posting');
const { decorateRecipe } = require('../modules/recipes');
const { consumeBatchesFEFO, restoreBatches } = require('../controllers/batches');
const { pickSerialForSale, markSerialSold, restoreSerial } = require('../controllers/serials');
const { baseQty, isWholeNumberUnit } = require('../controllers/unitConversion');
const { savePartyToDb } = require('../tenantProvisioner');
const router = express.Router();
const actor = (req) => req.headers['x-user-name'] || 'Owner';
const r2 = engine.r2;

// "2.5 pcs" is meaningless on a shop floor; the cart blocks it at entry, but every write path re-checks it so a bypassed/scripted request can't slip a fractional whole-unit line in.
const findFractionalQtyItem = (items) =>
  (items || []).find((i) => {
    const unit = i.unit || i.saleUnit || 'pcs';
    const qty = Number(i.qty);
    return isWholeNumberUnit(unit) && Number.isFinite(qty) && qty % 1 !== 0;
  });

/* --------------------------------- init --------------------------------- */

// The store was already loaded from the tenant's own database by resolveTenantDb, so this reads straight from it.
router.get('/init', (req, res) => {
  const store = req.tenantStore;

  const products = (store.products || []).map((p) => {
    if (!p.isComposite && p.productType !== 'composite') return p;
    let recipe = (store.recipes || []).find((r) => r.productId === p.id);
    if (!recipe && Array.isArray(p.recipeItems) && p.recipeItems.length) {
      recipe = {
        id: `rec_${p.id}`,
        productId: p.id,
        productName: p.name,
        yieldQty: 1,
        ingredients: p.recipeItems,
        notes: p.recipeNotes || ''
      };
    }
    const decorated = recipe ? decorateRecipe(store, recipe) : null;
    return {
      ...p,
      recipeItems: p.recipeItems?.length ? p.recipeItems : (recipe?.ingredients || []),
      recipe: decorated
    };
  });

  const topBilled = {};
  const recentBilledIds = [];
  const seenRecent = new Set();

  (store.orders || []).filter((o) => o.status !== 'VOID').forEach((o) => {
    (o.items || []).forEach((item) => {
      const key = item.id || item.productId || item.name;
      if (key && !seenRecent.has(key)) {
        seenRecent.add(key);
        recentBilledIds.push(key);
      }
      if (!topBilled[key]) {
        topBilled[key] = { count: 0, qty: 0 };
      }
      topBilled[key].count += 1;
      topBilled[key].qty = Math.round(((topBilled[key].qty || 0) + (Number(item.qty) || 1)) * 1000) / 1000;
      if (item.name && item.name !== key && !topBilled[item.name]) {
        topBilled[item.name] = topBilled[key];
      }
    });
  });

  res.json({
    success: true,
    tenantDb: req.tenantDbName,
    shop: req.tenant ? { name: req.tenant.name, email: req.tenant.email, plan: req.tenant.plan } : undefined,
    data: {
      categories: store.categories || [],
      products,
      topBilled,
      recentBilledIds,
      session: store.session,
      customers: (store.customers || []).map((c) => {
        const account = (store.accounts || []).find((a) => a.partyId === c.id && a.partyType === 'CUSTOMER');
        const balance = account ? engine.accountBalance(store, account.id) : Number(c.outstanding || 0);
        return {
          ...c,
          outstanding: Math.max(0, balance),
          advance: Math.max(0, -balance)
        };
      }),
      vendors: store.vendors || [],
      heldBills: store.heldBills || [],
      tables: store.tables || [],
      settings: store.settings,
      priceSheets: store.priceSheets || [],
      users: (store.users || []).map(({ pin, ...u }) => u)
    }
  });
});

/* ------------------------------- held bills ------------------------------- */

router.get('/bills/held', (req, res) => {
  res.json({ success: true, data: req.tenantStore.heldBills || [] });
});

router.post('/bills/hold', (req, res) => {
  const store = req.tenantStore;
  const { customerName, customerId, items, total, notes, tableId } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cannot hold an empty cart.' });
  }

  const heldBill = {
    id: `hb_${Date.now()}`,
    customerName: customerName || 'Walk-in Customer',
    customerId: customerId || null,
    items,
    total: Number(total),
    notes: notes || 'Hold Bill',
    tableId: tableId || null,
    heldBy: actor(req),
    heldAt: new Date().toISOString()
  };

  store.heldBills.unshift(heldBill);

  if (tableId) {
    const table = (store.tables || []).find((t) => t.id === tableId);
    if (table) {
      table.status = 'OCCUPIED';
      table.currentBillId = heldBill.id;
      table.occupiedAt = heldBill.heldAt;
    }
  }

  res.status(201).json({ success: true, message: 'Bill held successfully.', data: heldBill });
});

router.delete('/bills/held/:id', (req, res) => {
  const store = req.tenantStore;
  const bill = (store.heldBills || []).find((h) => h.id === req.params.id);
  store.heldBills = (store.heldBills || []).filter((h) => h.id !== req.params.id);

  if (bill && bill.tableId) {
    const table = (store.tables || []).find((t) => t.id === bill.tableId);
    if (table) Object.assign(table, { status: 'FREE', currentBillId: null, occupiedAt: null });
  }

  res.json({ success: true, message: 'Held bill resumed/cleared.' });
});

/* -------------------------------- checkout -------------------------------- */

// Consumes shop floor (wh_shop) first, then wh_main. Batch-tracked products deduct FEFO from product.batches instead (not warehouse-scoped yet); serial-tracked products mark one unit (preferredSerialId or oldest in stock) sold, with warranty starting from saleDate.
function deductWarehouseStock(product, qtyToDeduct, preferredBatchId, preferredSerialId, orderId, saleDate) {
  const deduct = Number(qtyToDeduct) || 0;
  if (deduct <= 0) return null;

  if (product.trackBatches) {
    return consumeBatchesFEFO(product, deduct, preferredBatchId);
  }

  if (product.trackSerials) {
    const target = pickSerialForSale(product, preferredSerialId);
    if (!target) return { serialShortage: true };
    const sold = markSerialSold(product, target.id, orderId, saleDate);
    return { serialSold: sold };
  }

  const currentStock = Number(product.stock || 0);
  product.stock = r2(currentStock - deduct);

  if (product.warehouses && typeof product.warehouses === 'object' && Object.keys(product.warehouses).length > 0) {
    let remainingToDeduct = deduct;
    if (product.warehouses.wh_shop !== undefined) {
      const availableShop = Number(product.warehouses.wh_shop || 0);
      const fromShop = Math.min(Math.max(0, availableShop), remainingToDeduct);
      product.warehouses.wh_shop = r2(availableShop - fromShop);
      remainingToDeduct = r2(remainingToDeduct - fromShop);
    }
    if (remainingToDeduct > 0) {
      const mainWh = product.warehouses.wh_main !== undefined ? 'wh_main' : Object.keys(product.warehouses)[0];
      if (mainWh) {
        product.warehouses[mainWh] = r2(Number(product.warehouses[mainWh] || 0) - remainingToDeduct);
      }
    }
    product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
  }
  return null;
}

// Mirrors deductWarehouseStock for void/delete: restores into the exact recorded batchesSold (falling back to a placeholder for legacy orders), and puts a serial-tracked unit back to IN_STOCK with its warranty window cleared.
function restoreWarehouseStock(product, qtyToRestore, batchesSold, serialSoldId) {
  const restore = Number(qtyToRestore) || 0;
  if (restore <= 0) return;

  if (product.trackBatches) {
    if (Array.isArray(batchesSold) && batchesSold.length) {
      restoreBatches(product, batchesSold);
    } else {
      restoreBatches(product, [{ batchId: null, batchNo: 'RESTORED', qty: restore }]);
    }
    return;
  }

  if (product.trackSerials) {
    if (serialSoldId) restoreSerial(product, serialSoldId);
    return;
  }

  const currentStock = Number(product.stock || 0);
  product.stock = r2(currentStock + restore);

  if (product.warehouses && typeof product.warehouses === 'object' && Object.keys(product.warehouses).length > 0) {
    const shopWh = product.warehouses.wh_shop !== undefined ? 'wh_shop' : (Object.keys(product.warehouses)[0] || 'wh_main');
    product.warehouses[shopWh] = r2(Number(product.warehouses[shopWh] || 0) + restore);
    product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
  }
}

function findProductInStore(store, item) {
  if (!item || !Array.isArray(store.products)) return null;
  const itemId = item.id || item.productId;
  const itemBarcode = item.barcode ? String(item.barcode).trim() : '';
  const itemName = item.name ? String(item.name).trim().toLowerCase() : '';

  return store.products.find((p) => {
    if (itemId && (p.id === itemId || p._id === itemId)) return true;
    if (itemBarcode && (p.barcode === itemBarcode || (Array.isArray(p.barcodes) && p.barcodes.includes(itemBarcode)))) return true;
    if (itemName && p.name && p.name.trim().toLowerCase() === itemName) return true;
    return false;
  });
}

// A composite product consumes its recipe ingredients instead of its own (notional) stock, keeping raw-material inventory honest for bakeries/kitchens.
function deductStock(store, items, orderId, user) {
  const shortages = [];

  items.forEach((cartItem) => {
    const product = findProductInStore(store, cartItem);
    if (!product) return;

    const soldQty = baseQty(product, cartItem);
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      const yieldQty = Number(recipe?.yieldQty) || Number(product.recipeYieldQty) || 1;
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId || (p.name && ing.name && p.name.trim().toLowerCase() === ing.name.trim().toLowerCase()));
        if (!raw) return;
        const reqPerUnit = (Number(ing.qty) || 0) / yieldQty;
        const deducted = Math.round(reqPerUnit * soldQty * 10000) / 10000;

        if (raw.stock < deducted) {
          shortages.push({ name: raw.name, available: raw.stock });
        }

        deductWarehouseStock(raw, deducted);

        logStockMovement(store, {
          product: raw,
          type: 'SALE',
          qtyChange: -deducted,
          reason: `Consumed in ${product.name} (Sold on ${orderId})`,
          refId: orderId,
          user
        });
      });
      return;
    }

    const isCombo = product.isCombo || product.productType === 'combo';
    const comboItems = product.comboItems || product.bundleItems || [];
    if (isCombo && comboItems.length > 0) {
      comboItems.forEach((ci) => {
        const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
        if (!comp) return;
        const compQty = Number(ci.qty || ci.quantity || 1);
        const deducted = Math.round(compQty * soldQty * 10000) / 10000;

        if (comp.stock < deducted) {
          shortages.push({ name: comp.name, available: comp.stock });
        }

        deductWarehouseStock(comp, deducted);

        logStockMovement(store, {
          product: comp,
          type: 'SALE',
          qtyChange: -deducted,
          reason: `Bundled in combo ${product.name} (Sold on ${orderId})`,
          refId: orderId,
          user
        });
      });
      return;
    }

    if (product.stock < soldQty) {
      shortages.push({ name: product.name, available: product.stock });
    }

    const stockResult = deductWarehouseStock(product, soldQty, cartItem.batchId, cartItem.serialId, orderId, cartItem.saleDate);
    if (stockResult?.consumed) cartItem.batchesSold = stockResult.consumed;
    if (stockResult?.serialSold) {
      cartItem.serialId = stockResult.serialSold.id;
      cartItem.serialNo = stockResult.serialSold.serialNo;
      cartItem.warrantyEndDate = stockResult.serialSold.warrantyEndDate || null;
    }
    if (stockResult?.serialShortage) {
      shortages.push({ name: product.name, available: 0, message: 'No serial-tracked units left in stock.' });
    }

    logStockMovement(store, {
      product,
      type: 'SALE',
      qtyChange: -soldQty,
      reason: `Sold on ${orderId}`,
      refId: orderId,
      user
    });
  });

  return shortages;
}

// Read-only mirror of deductStock's traversal, used only when "Allow Billing Below Zero Stock" is off — runs first and touches nothing, so the checkout is rejected before any stock moves rather than partway through deductStock's mutation.
function findStockShortages(store, items) {
  const shortages = [];

  items.forEach((cartItem) => {
    const product = findProductInStore(store, cartItem);
    if (!product) return;

    const soldQty = baseQty(product, cartItem);
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      const yieldQty = Number(recipe?.yieldQty) || Number(product.recipeYieldQty) || 1;
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId || (p.name && ing.name && p.name.trim().toLowerCase() === ing.name.trim().toLowerCase()));
        if (!raw) return;
        const reqPerUnit = (Number(ing.qty) || 0) / yieldQty;
        const needed = Math.round(reqPerUnit * soldQty * 10000) / 10000;
        if (Number(raw.stock || 0) < needed) {
          shortages.push({ name: raw.name, available: Number(raw.stock || 0), needed });
        }
      });
      return;
    }

    const isCombo = product.isCombo || product.productType === 'combo';
    const comboItems = product.comboItems || product.bundleItems || [];
    if (isCombo && comboItems.length > 0) {
      comboItems.forEach((ci) => {
        const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
        if (!comp) return;
        const compQty = Number(ci.qty || ci.quantity || 1);
        const needed = Math.round(compQty * soldQty * 10000) / 10000;
        if (Number(comp.stock || 0) < needed) {
          shortages.push({ name: comp.name, available: Number(comp.stock || 0), needed });
        }
      });
      return;
    }

    // product.stock is kept in sync as the true available count for plain, batch-summed and serial-summed stock alike, so one check covers all three.
    if (Number(product.stock || 0) < soldQty) {
      shortages.push({ name: product.name, available: Number(product.stock || 0), needed: soldQty });
    }
  });

  return shortages;
}

/** True once a shop has explicitly turned billing-below-zero OFF; missing/undefined defaults to allowed, same as the stock-adjustment guard elsewhere. */
const negativeStockBlocked = (store) => store.settings?.pos && store.settings.pos.allowNegativeStock === false;

router.post('/orders', async (req, res) => {
  try {
  const store = req.tenantStore;
  const {
    customerName, customerPhone, customerId, customerGstin, customerPan, customerAddress,
    customerState, customerStateCode, paymentMethod,
    subtotal, tax, discount, roundOff, total, items, tableId, splitPayments, notes,
    redeemPoints, redeemAdvanceAmount, dueDate, placeOfSupply, vendorCode, dispatchFrom, dispatchDate,
    shipToName, shipToAddress, vehicleNo, shipBy, transporterName,
    buyerRef, buyerRefDate, buyerOrderNo, buyerOrderDate, dispatchDocNo, termsOfDelivery, paymentTerms
  } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Cart is empty.' });
  }

  // A negative/zero qty or negative price flips stock deduction into an addition and inverts the bill total — verified live: an unguarded qty:-1 line raised stock and posted a -₹10 "COMPLETED" sale.
  const badItem = (items || []).find((i) => !(Number(i.qty) > 0) || Number(i.price) < 0);
  if (badItem) {
    return res.status(400).json({
      success: false,
      message: `Invalid quantity or price for "${badItem.name || badItem.id || 'item'}". Quantity must be greater than zero and price cannot be negative.`
    });
  }

  const fractionalItem = findFractionalQtyItem(items);
  if (fractionalItem) {
    return res.status(400).json({
      success: false,
      message: `"${fractionalItem.name || fractionalItem.id || 'Item'}" is billed in ${fractionalItem.unit || fractionalItem.saleUnit} — quantity must be a whole number.`
    });
  }

  const billing = store.settings.billing;
  const orderId = `${billing.invoicePrefix || 'INV'}-${new Date().getFullYear()}-${String(billing.nextInvoiceNo || 1).padStart(4, '0')}`;
  billing.nextInvoiceNo = (billing.nextInvoiceNo || 1) + 1;

  // Resolve or create the customer record for credit sales and loyalty.
  let customer = null;
  if (customerId) customer = store.customers.find((c) => c.id === customerId);
  if (!customer && customerName && customerName !== 'Walk-in Customer') {
    customer = store.customers.find((c) => c.name.toLowerCase() === customerName.toLowerCase());
    if (!customer && posting.isCreditSale(paymentMethod)) {
      customer = {
        id: `c_${Date.now()}`,
        name: customerName,
        phone: customerPhone || 'N/A',
        email: '',
        address: '',
        group: 'Retail',
        creditLimit: 0,
        outstanding: 0,
        loyaltyPoints: 0,
        createdAt: new Date().toISOString()
      };
      store.customers.push(customer);
    }
  }

  if (posting.isCreditSale(paymentMethod) && !customer) {
    return res.status(400).json({
      success: false,
      message: 'A named customer is required for a credit (udhar) sale.'
    });
  }

  // Loyalty redemption: points come off the bill before it is posted, so the ledger, the drawer and the printed receipt all agree on what the customer actually paid.
  const pos = store.settings.pos || {};
  let loyaltyRedeemed = 0;
  let pointsRedeemed = 0;

  if (redeemPoints && customer && pos.enableLoyalty !== false) {
    const wanted = Math.floor(Number(redeemPoints));
    const available = customer.loyaltyPoints || 0;
    const minPoints = Number(pos.loyaltyMinRedeemPoints) || 0;
    const maxPercent = Number(pos.loyaltyMaxRedeemPercent) || 100;
    const maxRedeemAmount = r2((Number(total) * maxPercent) / 100);

    if (wanted > available) {
      return res.status(400).json({
        success: false,
        message: `${customer.name} has only ${available} point(s) available.`
      });
    }
    if (wanted < minPoints) {
      return res.status(400).json({
        success: false,
        message: `At least ${minPoints} points are needed before they can be redeemed.`
      });
    }

    const rate = Number(pos.loyaltyRedeemValue) || 0;
    // Redemption can settle a bill but never turn it into a refund.
    loyaltyRedeemed = Math.min(r2(wanted * rate), r2(total), maxRedeemAmount);
    pointsRedeemed = rate > 0 ? Math.ceil(loyaltyRedeemed / rate) : 0;
    customer.loyaltyPoints = available - pointsRedeemed;
  }

  // Customer Advance / Store Credit
  let advanceRedeemed = 0;
  if (customer && Number(redeemAdvanceAmount) > 0) {
    const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
    const ledgerBal = account ? engine.accountBalance(store, account.id) : 0;
    // Trust the ledger balance alone — a stale customer.advance (e.g. after a void that never resynced it) could let a sale redeem an advance that no longer exists, under-collecting cash.
    const availableAdvance = Math.max(0, -ledgerBal);
    const maxApplicable = Math.max(0, r2(Number(total) - loyaltyRedeemed));
    advanceRedeemed = Math.min(r2(Number(redeemAdvanceAmount)), maxApplicable, r2(availableAdvance));
  }

  const payableTotal = r2(Math.max(0, Number(total) - loyaltyRedeemed - advanceRedeemed));

  // Multi-pay/split-tender: each method's amount is kept as its own line in order.payments so cash-drawer sync and postSale's ledger split know exactly how much of each was collected.
  const splitEntries = Array.isArray(splitPayments)
    ? splitPayments
        .map((p) => ({
          method: String(p.method || p.paymentMethod || 'Cash').trim() || 'Cash',
          amount: r2(Math.max(0, Number(p.amount) || 0)),
          ref: String(p.ref || p.paymentRef || '').trim()
        }))
        .filter((p) => p.amount > 0)
    : [];
  const isSplit = splitEntries.length > 0;

  const requestedStatus = String(req.body.status || '').toUpperCase();
  const isDraft = requestedStatus === 'DRAFT';
  const isExplicitUnpaid = requestedStatus === 'UNPAID' || requestedStatus === 'PENDING';

  // Partial payment or custom initial payment resolution
  let initialPaid = 0;
  if (isDraft || isExplicitUnpaid) {
    initialPaid = 0;
  } else if (isSplit) {
    initialPaid = Math.min(payableTotal, r2(splitEntries.reduce((sum, p) => sum + p.amount, 0)));
  } else if (req.body.paidAmount !== undefined || req.body.amountPaid !== undefined) {
    initialPaid = Math.min(payableTotal, Math.max(0, r2(Number(req.body.paidAmount ?? req.body.amountPaid ?? 0))));
  } else if (requestedStatus === 'PARTIALLY_PAID' || requestedStatus === 'PARTIAL') {
    initialPaid = Math.min(payableTotal, Math.max(0, r2(Number(req.body.paidAmount ?? req.body.amountPaid ?? 0))));
  } else if (posting.isCreditSale(paymentMethod)) {
    // A Credit (Udhar) checkout with no explicit paidAmount means nothing was collected upfront — falling through to "full payment" would hide the customer's real receivable.
    initialPaid = 0;
  } else {
    // Default checkout is full payment
    initialPaid = payableTotal;
  }

  let finalStatus;
  let paymentStatus;
  if (isDraft) {
    finalStatus = 'DRAFT';
    paymentStatus = 'DRAFT';
  } else if (initialPaid >= payableTotal) {
    finalStatus = 'PAID';
    paymentStatus = 'PAID';
  } else if (initialPaid > 0) {
    finalStatus = 'PARTIALLY_PAID';
    paymentStatus = 'PARTIALLY_PAID';
  } else {
    finalStatus = 'UNPAID';
    paymentStatus = 'UNPAID';
  }

  const balanceDue = isDraft ? payableTotal : r2(Math.max(0, payableTotal - initialPaid));

  if (!isDraft && negativeStockBlocked(store)) {
    const preCheckShortages = findStockShortages(store, items);
    if (preCheckShortages.length) {
      return res.status(400).json({
        success: false,
        message: `Not enough stock to bill: ${preCheckShortages.map((s) => `${s.name} (have ${s.available}, need ${s.needed})`).join('; ')}. Turn on "Allow Billing Below Zero Stock" in Settings, or adjust stock first.`,
        shortages: preCheckShortages
      });
    }
  }

  let shortages = [];
  if (!isDraft) {
    shortages = deductStock(store, items, orderId, actor(req));
  }

  const orderItems = (items || []).map((i) => {
    const product = findProductInStore(store, i);
    return {
      id: i.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: i.name || i.printName || 'Item',
      printName: i.printName || i.name || 'Item',
      barcode: i.barcode || '',
      qty: Number(i.qty) || 1,
      unit: i.unit || i.saleUnit || 'pcs',
      price: Number(i.price) || 0,
      taxRate: Number(i.taxRate) || 0,
      total: Number(i.total) || Math.round((Number(i.qty) || 1) * (Number(i.price) || 0) * 100) / 100,
      discount: Number(i.discount) || 0,
      hsn: i.hsn || (product ? product.hsn : '') || '',
      baseQty: product ? baseQty(product, i) : (Number(i.qty) || 1),
      batchesSold: Array.isArray(i.batchesSold) ? i.batchesSold : [],
      serialId: i.serialId || undefined,
      serialNo: i.serialNo || undefined,
      warrantyEndDate: i.warrantyEndDate || undefined
    };
  });

  const now = new Date().toISOString();
  const order = {
    orderId,
    customerId: customer ? customer.id : null,
    customerName: customer ? customer.name : customerName || 'Walk-in Customer',
    customerPhone: customer ? customer.phone : customerPhone || 'N/A',
    customerGstin: customerGstin || (customer ? customer.gstin : '') || '',
    customerPan: customerPan || (customer ? customer.pan : '') || '',
    customerAddress: customerAddress || (customer ? customer.address : '') || '',
    customerState: customerState || (customer ? customer.state : '') || '',
    customerStateCode: customerStateCode || (customer ? customer.stateCode : '') || '',
    dueDate: dueDate || null,
    placeOfSupply: placeOfSupply || '',
    vendorCode: vendorCode || '',
    dispatchFrom: dispatchFrom || '',
    dispatchDate: dispatchDate || null,
    shipToName: shipToName || '',
    shipToAddress: shipToAddress || '',
    vehicleNo: vehicleNo || '',
    shipBy: shipBy || '',
    transporterName: transporterName || '',
    buyerRef: buyerRef || '',
    buyerRefDate: buyerRefDate || null,
    buyerOrderNo: buyerOrderNo || '',
    buyerOrderDate: buyerOrderDate || null,
    dispatchDocNo: dispatchDocNo || '',
    termsOfDelivery: termsOfDelivery || '',
    paymentTerms: paymentTerms || '',
    paymentMethod: payableTotal === 0 && advanceRedeemed > 0 ? 'Advance / Store Credit' : (isSplit ? 'Split Payment' : (paymentMethod || 'Cash')),
    paymentRef: req.body.paymentRef || '',
    splitPayments: isSplit ? splitEntries : null,
    subtotal: r2(subtotal),
    tax: r2(tax),
    discount: r2(discount),
    roundOff: r2(roundOff || 0),
    loyaltyRedeemed,
    pointsRedeemed,
    advanceRedeemed,
    advanceBalance: customer ? Math.max(0, (Number(customer.advance) || 0) - advanceRedeemed) : 0,
    grossTotal: r2(total),
    total: payableTotal,
    paidAmount: initialPaid,
    balanceDue: balanceDue,
    payments: isSplit
      ? splitEntries.map((p) => ({
          id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          amount: p.amount,
          paymentMethod: p.method,
          paymentRef: p.ref,
          paidAt: now,
          receivedBy: actor(req),
          notes: req.body.paymentNotes || req.body.notes || 'Split payment'
        }))
      : initialPaid > 0 ? [
        {
          id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          amount: initialPaid,
          paymentMethod: payableTotal === 0 && advanceRedeemed > 0 ? 'Advance / Store Credit' : paymentMethod || 'Cash',
          paymentRef: req.body.paymentRef || '',
          paidAt: now,
          receivedBy: actor(req),
          notes: req.body.paymentNotes || req.body.notes || 'Initial payment'
        }
      ] : [],
    notes: notes || '',
    tableId: tableId || null,
    cashier: actor(req),
    sessionId: store.session?.id || null,
    date: now,
    status: finalStatus,
    paymentStatus,
    paidAt: initialPaid >= payableTotal && payableTotal > 0 ? now : null,
    items: orderItems
  };

  // Points accrue on what was actually paid
  if (!isDraft && customer && pos.enableLoyalty !== false) {
    const minSpend = Number(pos.loyaltyMinSpendToEarn) || 0;
    const spendUnit = Math.max(1, Number(pos.loyaltySpendAmount) || 100);
    const pointsPerSpend = Number(pos.loyaltyPointsPerSpend ?? pos.loyaltyPointsPerHundred ?? 1) || 1;

    let earned = 0;
    if (initialPaid >= minSpend) {
      earned = Math.floor((initialPaid / spendUnit) * pointsPerSpend);
    }
    customer.loyaltyPoints = (customer.loyaltyPoints || 0) + earned;
    order.loyaltyEarned = earned;
    order.loyaltyBalance = customer.loyaltyPoints;
  }

  // Credit only cash actually collected — a split payment's top-level order.paymentMethod is the composite label 'Split Payment', so order.payments (per-method) is the source of truth here, as void/delete already treat it.
  const cashCollected = (order.payments || [])
    .filter((p) => String(p.paymentMethod).toLowerCase() === 'cash')
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  if (!isDraft && cashCollected > 0 && store.session) {
    store.session.currentCash = r2(store.session.currentCash + cashCollected);
    store.session.cashEntries.push({
      type: 'IN',
      amount: cashCollected,
      reason: `Sale ${orderId}`,
      time: order.date
    });
  }

  // Double-entry posting
  let accounting = null;
  if (!isDraft) {
    try {
      accounting = posting.postSale(store, order, {
        customer,
        interState: store.settings.tax.interState,
        createdBy: actor(req)
      });
      order.voucherNo = accounting?.voucher?.voucherNo || null;
      order.voucherId = accounting?.voucher?.id || null;
      order.cogs = accounting?.cogsAmount || 0;
    } catch (err) {
      order.accountingError = err.message;
    }
  }

  if (customer && !isDraft) {
    const account = (store.accounts || []).find(
      (a) => a.partyId === customer.id && a.partyType === 'CUSTOMER'
    );
    if (account) {
      const currentBal = engine.accountBalance(store, account.id);
      customer.outstanding = Math.max(0, currentBal);
      customer.advance = Math.max(0, -currentBal);
      order.advanceBalance = customer.advance;
    }
  }

  store.orders.unshift(order);

  if (tableId) {
    const table = (store.tables || []).find((t) => t.id === tableId);
    if (table) Object.assign(table, { status: 'FREE', currentBillId: null, occupiedAt: null });
  }

  res.status(201).json({
    success: true,
    message: isDraft
      ? `Draft invoice ${orderId} saved.`
      : finalStatus === 'PARTIALLY_PAID'
      ? `Invoice ${orderId} created with partial payment of ₹${initialPaid}. Balance due: ₹${balanceDue}.`
      : isExplicitUnpaid
      ? `Invoice ${orderId} issued (Unpaid).`
      : 'Sale checkout completed successfully.',
    warnings: shortages.length ? shortages.map((s) => `${s.name}: only ${s.available} left`) : [],
    data: { ...order, company: store.settings.company, billing: store.settings.billing }
  });
  } catch (err) {
    console.error('[POST /orders]', err);
    res.status(500).json({ success: false, message: 'Could not complete checkout. Please try again.' });
  }
});

router.get('/orders', (req, res) => {
  const store = req.tenantStore;
  const { from, to, q, paymentMethod, status, limit } = req.query;

  let rows = [...(store.orders || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (status && status !== 'ALL') {
    if (status === 'UNPAID') {
      rows = rows.filter((o) => o.status === 'UNPAID' || o.paymentStatus === 'UNPAID' || o.status === 'PARTIALLY_PAID' || o.paymentStatus === 'PARTIALLY_PAID');
    } else {
      rows = rows.filter((o) => o.status === status || o.paymentStatus === status);
    }
  }
  if (from) rows = rows.filter((o) => engine.dayKey(o.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((o) => engine.dayKey(o.date) <= engine.dayKey(to));
  if (paymentMethod && paymentMethod !== 'ALL') rows = rows.filter((o) => o.paymentMethod === paymentMethod);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (o) => (o.orderId || '').toLowerCase().includes(needle) || (o.customerName || '').toLowerCase().includes(needle) || (o.customerPhone || '').includes(needle)
    );
  }

  const today = engine.dayKey(new Date());
  const isOverdue = (o) =>
    o.status !== 'VOID' && o.status !== 'DRAFT' && o.paymentStatus !== 'PAID' && !!o.dueDate && engine.dayKey(o.dueDate) < today;
  rows = rows.map((o) => ({ ...o, isOverdue: isOverdue(o) }));

  res.json({ success: true, data: rows.slice(0, Number(limit) || 500), count: rows.length });
});

router.get('/orders/:orderId', (req, res) => {
  const store = req.tenantStore;
  const order = store.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  const today = engine.dayKey(new Date());
  const isOverdue =
    order.status !== 'VOID' && order.status !== 'DRAFT' && order.paymentStatus !== 'PAID' && !!order.dueDate && engine.dayKey(order.dueDate) < today;
  res.json({ success: true, data: { ...order, isOverdue, company: store.settings.company, billing: store.settings.billing } });
});

/** Mark an unpaid/partial invoice as Paid / Record Full or Partial Payment */
router.post('/orders/:orderId/pay', async (req, res) => {
  const store = req.tenantStore;
  const order = (store.orders || []).find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (order.status === 'VOID') return res.status(400).json({ success: false, message: 'Cannot record payment for a voided invoice.' });
  if (order.status === 'DRAFT') return res.status(400).json({ success: false, message: 'Draft invoice must be issued before recording payments.' });

  const total = Number(order.total) || 0;
  const currentPaid = Number(order.paidAmount !== undefined ? order.paidAmount : (order.status === 'PAID' ? total : 0));
  const currentDue = r2(order.balanceDue !== undefined ? Number(order.balanceDue) : Math.max(0, total - currentPaid));

  if (currentDue <= 0 && (order.status === 'PAID' || order.paymentStatus === 'PAID')) {
    return res.status(400).json({ success: false, message: 'Invoice is already fully paid.' });
  }

  const { amount, amountPaid, paidAmount, paymentMethod, paymentRef, notes } = req.body;
  const requestedAmt = Number(amount ?? amountPaid ?? paidAmount ?? currentDue);
  if (isNaN(requestedAmt) || requestedAmt <= 0) {
    return res.status(400).json({ success: false, message: 'Payment amount must be greater than zero.' });
  }

  const payAmt = Math.min(currentDue, r2(requestedAmt));
  const newPaidTotal = r2(currentPaid + payAmt);
  const newDue = r2(Math.max(0, total - newPaidTotal));
  const method = paymentMethod || order.paymentMethod || 'Cash';
  const now = new Date().toISOString();

  order.paidAmount = newPaidTotal;
  order.balanceDue = newDue;
  if (newDue <= 0) {
    order.status = 'PAID';
    order.paymentStatus = 'PAID';
    order.paidAt = now;
  } else {
    order.status = 'PARTIALLY_PAID';
    order.paymentStatus = 'PARTIALLY_PAID';
  }

  if (method) order.paymentMethod = method;
  if (paymentRef) order.paymentRef = paymentRef;
  if (notes) order.paymentNotes = notes;

  if (!Array.isArray(order.payments)) {
    order.payments = currentPaid > 0 ? [{
      id: `pay_prev_${order.orderId}`,
      amount: currentPaid,
      paymentMethod: order.paymentMethod || 'Cash',
      paymentRef: order.paymentRef || '',
      paidAt: order.paidAt || order.date,
      receivedBy: order.cashier || 'Cashier',
      notes: 'Previous payment'
    }] : [];
  }

  order.payments.push({
    id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    amount: payAmt,
    paymentMethod: method,
    paymentRef: paymentRef || '',
    notes: notes || '',
    paidAt: now,
    receivedBy: actor(req)
  });

  // Add cash to active drawer session if cash payment
  if (String(method).toLowerCase() === 'cash' && store.session && payAmt > 0) {
    store.session.currentCash = r2(store.session.currentCash + payAmt);
    store.session.cashEntries.push({
      type: 'IN',
      amount: payAmt,
      reason: `Payment for Invoice ${order.orderId}`,
      time: now
    });
  }

  // Post the money collected to the books (Cash/Bank up, receivable down) and resync outstanding/advance off the ledger — without this, /pay moved the invoice to PAID while the udhar balance stayed stuck at its pre-payment figure.
  if (order.customerId) {
    const customer = (store.customers || []).find((c) => c.id === order.customerId);
    if (customer) {
      try {
        posting.postReceipt(
          store,
          {
            id: order.orderId,
            amount: payAmt,
            discount: 0,
            paymentMode: method,
            date: now,
            notes: `Payment for Invoice ${order.orderId}`
          },
          { customer, createdBy: actor(req) }
        );
      } catch (err) {
        order.accountingError = err.message;
      }
      const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
      if (account) {
        const currentBal = engine.accountBalance(store, account.id);
        customer.outstanding = Math.max(0, currentBal);
        customer.advance = Math.max(0, -currentBal);
      }
    }
  }

  const isFull = newDue <= 0;
  res.json({
    success: true,
    message: isFull
      ? `Payment of ₹${payAmt} recorded. Invoice #${order.orderId} is now fully PAID.`
      : `Partial payment of ₹${payAmt} recorded. Remaining balance: ₹${newDue}.`,
    data: { ...order, company: store.settings.company, billing: store.settings.billing }
  });
});

/** Issue / Confirm a Draft Invoice (Full, Partial, or Unpaid) */
router.post('/orders/:orderId/issue', async (req, res) => {
  const store = req.tenantStore;
  const order = (store.orders || []).find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (order.status !== 'DRAFT') {
    return res.status(400).json({ success: false, message: 'Invoice is already issued.' });
  }

  // Same guard as POST /orders — a draft can be edited via PUT before being issued, so re-check its (possibly since-edited) items right before stock is deducted.
  const badItem = (order.items || []).find((i) => !(Number(i.qty) > 0) || Number(i.price) < 0);
  if (badItem) {
    return res.status(400).json({
      success: false,
      message: `Invalid quantity or price for "${badItem.name || badItem.id || 'item'}". Quantity must be greater than zero and price cannot be negative.`
    });
  }

  const fractionalItem = findFractionalQtyItem(order.items);
  if (fractionalItem) {
    return res.status(400).json({
      success: false,
      message: `"${fractionalItem.name || fractionalItem.id || 'Item'}" is billed in ${fractionalItem.unit || fractionalItem.saleUnit} — quantity must be a whole number.`
    });
  }

  const targetStatus = String(req.body.status || '').toUpperCase();
  const paymentMethod = req.body.paymentMethod || order.paymentMethod || 'Cash';
  const paymentRef = req.body.paymentRef || '';
  const now = new Date().toISOString();

  let initialPaid = 0;
  let finalStatus;
  let paymentStatus;

  if (targetStatus === 'PAID') {
    initialPaid = order.total;
    finalStatus = 'PAID';
    paymentStatus = 'PAID';
  } else if (targetStatus === 'PARTIALLY_PAID' || targetStatus === 'PARTIAL') {
    initialPaid = Math.min(order.total, Math.max(0, r2(Number(req.body.paidAmount ?? req.body.amountPaid ?? 0))));
    if (initialPaid >= order.total) {
      finalStatus = 'PAID';
      paymentStatus = 'PAID';
    } else if (initialPaid > 0) {
      finalStatus = 'PARTIALLY_PAID';
      paymentStatus = 'PARTIALLY_PAID';
    } else {
      finalStatus = 'UNPAID';
      paymentStatus = 'UNPAID';
    }
  } else {
    initialPaid = 0;
    finalStatus = 'UNPAID';
    paymentStatus = 'UNPAID';
  }

  if (negativeStockBlocked(store)) {
    const preCheckShortages = findStockShortages(store, order.items);
    if (preCheckShortages.length) {
      return res.status(400).json({
        success: false,
        message: `Not enough stock to issue this invoice: ${preCheckShortages.map((s) => `${s.name} (have ${s.available}, need ${s.needed})`).join('; ')}. Turn on "Allow Billing Below Zero Stock" in Settings, or adjust stock first.`,
        shortages: preCheckShortages
      });
    }
  }

  const shortages = deductStock(store, order.items, order.orderId, actor(req));

  order.status = finalStatus;
  order.paymentStatus = paymentStatus;
  order.paymentMethod = paymentMethod;
  order.paymentRef = paymentRef;
  order.paidAmount = initialPaid;
  order.balanceDue = r2(Math.max(0, order.total - initialPaid));
  order.issuedAt = now;

  if (initialPaid > 0) {
    order.paidAt = initialPaid >= order.total ? now : null;
    order.payments = [
      {
        id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        amount: initialPaid,
        paymentMethod,
        paymentRef,
        paidAt: now,
        receivedBy: actor(req),
        notes: 'Initial payment upon issuance'
      }
    ];
    if (String(paymentMethod).toLowerCase() === 'cash' && store.session) {
      store.session.currentCash = r2(store.session.currentCash + initialPaid);
      store.session.cashEntries.push({
        type: 'IN',
        amount: initialPaid,
        reason: `Payment for Invoice ${order.orderId}`,
        time: now
      });
    }
  } else {
    order.payments = [];
  }

  let customer = null;
  if (order.customerId) customer = (store.customers || []).find((c) => c.id === order.customerId);
  try {
    const accounting = posting.postSale(store, order, {
      customer,
      interState: store.settings.tax.interState,
      createdBy: actor(req)
    });
    order.voucherNo = accounting?.voucher?.voucherNo || null;
    order.voucherId = accounting?.voucher?.id || null;
    order.cogs = accounting?.cogsAmount || 0;
  } catch (err) {
    order.accountingError = err.message;
  }

  res.json({
    success: true,
    message: `Draft Invoice #${order.orderId} successfully issued as ${finalStatus}!`,
    warnings: shortages.length ? shortages.map((s) => `${s.name}: only ${s.available} left`) : [],
    data: { ...order, company: store.settings.company, billing: store.settings.billing }
  });
});

// Header/party details safe to correct on an issued invoice without touching stock/ledger; items, quantities, prices and totals are deliberately excluded — see LOCKED_FIELDS_ON_ISSUED below.
const EDITABLE_DETAIL_FIELDS = [
  { key: 'customerName', label: 'Customer Name' },
  { key: 'customerPhone', label: 'Customer Phone' },
  { key: 'customerGstin', label: 'Customer GSTIN' },
  { key: 'customerPan', label: 'Customer PAN' },
  { key: 'customerAddress', label: 'Customer Address' },
  { key: 'customerState', label: 'Customer State' },
  { key: 'customerStateCode', label: 'Customer State Code' },
  { key: 'notes', label: 'Notes' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'placeOfSupply', label: 'Place of Supply' },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'dispatchFrom', label: 'Dispatch From' },
  { key: 'dispatchDate', label: 'Dispatch Date' },
  { key: 'shipToName', label: 'Ship To Name' },
  { key: 'shipToAddress', label: 'Ship To Address' },
  { key: 'vehicleNo', label: 'Vehicle No' },
  { key: 'shipBy', label: 'Ship By' },
  { key: 'transporterName', label: 'Transporter Name' },
  { key: 'buyerRef', label: 'Buyer Reference' },
  { key: 'buyerRefDate', label: 'Buyer Reference Date' },
  { key: 'buyerOrderNo', label: 'Buyer Order No' },
  { key: 'buyerOrderDate', label: 'Buyer Order Date' },
  { key: 'dispatchDocNo', label: 'Dispatch Doc No' },
  { key: 'termsOfDelivery', label: 'Terms of Delivery' },
  { key: 'paymentTerms', label: 'Payment Terms' },
  { key: 'paymentRef', label: 'Payment Reference' }
];

// Rejected outright on an issued invoice's details-only edit — these all feed stock deduction or the ledger, so changing them would desync inventory/books from what was posted at checkout.
const LOCKED_FIELDS_ON_ISSUED = [
  'items', 'subtotal', 'tax', 'discount', 'roundOff', 'total', 'grossTotal',
  'paymentMethod', 'paidAmount', 'balanceDue', 'status', 'paymentStatus'
];

/** Records a field-level diff on the order (for its own "Edited" history) and the tenant-wide edit log. */
function logInvoiceEdit(store, order, changes, user) {
  if (!changes.length) return null;
  const now = new Date().toISOString();
  const entry = {
    id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    orderId: order.orderId,
    editedBy: user,
    editedAt: now,
    changes
  };

  if (!Array.isArray(store.invoiceEditLogs)) store.invoiceEditLogs = [];
  store.invoiceEditLogs.unshift(entry);
  if (store.invoiceEditLogs.length > 2000) store.invoiceEditLogs.pop();

  if (!Array.isArray(order.editHistory)) order.editHistory = [];
  order.editHistory.unshift(entry);

  order.isEdited = true;
  order.lastEditedAt = now;
  order.lastEditedBy = user;
  return entry;
}

/** Update an invoice/bill — a Draft may be freely edited; an issued one is limited to header/party details. */
router.put('/orders/:orderId', (req, res) => {
  const store = req.tenantStore;
  const order = (store.orders || []).find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });

  if (order.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Voided invoices cannot be edited.' });
  }

  if (order.status !== 'DRAFT') {
    const lockedKeysPresent = LOCKED_FIELDS_ON_ISSUED.filter((k) => req.body[k] !== undefined);
    if (lockedKeysPresent.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Items and amounts on an issued invoice can't be edited directly — void the invoice or raise a Sales Return (credit note) instead. (Blocked field${lockedKeysPresent.length > 1 ? 's' : ''}: ${lockedKeysPresent.join(', ')})`
      });
    }

    const changes = [];
    EDITABLE_DETAIL_FIELDS.forEach(({ key, label }) => {
      if (req.body[key] === undefined) return;
      const oldValue = order[key] ?? '';
      const newValue = req.body[key] ?? '';
      if (String(oldValue) !== String(newValue)) {
        changes.push({ field: key, label, oldValue, newValue });
        order[key] = req.body[key];
      }
    });

    if (changes.length > 0) logInvoiceEdit(store, order, changes, actor(req));

    return res.json({
      success: true,
      message: changes.length > 0 ? `Invoice #${order.orderId} details updated.` : 'No changes to save.',
      data: { ...order, company: store.settings.company, billing: store.settings.billing }
    });
  }

  const {
    customerName, customerPhone, customerId, customerGstin, customerPan, customerAddress,
    customerState, customerStateCode, paymentMethod,
    subtotal, tax, discount, roundOff, total, items, notes, dueDate
  } = req.body;

  // Same guard as POST /orders — a draft edited here with a bogus qty/price
  // would carry it straight through to /issue's stock deduction unchecked.
  if (Array.isArray(items) && items.length > 0) {
    const badItem = items.find((i) => !(Number(i.qty) > 0) || Number(i.price) < 0);
    if (badItem) {
      return res.status(400).json({
        success: false,
        message: `Invalid quantity or price for "${badItem.name || badItem.id || 'item'}". Quantity must be greater than zero and price cannot be negative.`
      });
    }
    const fractionalItem = findFractionalQtyItem(items);
    if (fractionalItem) {
      return res.status(400).json({
        success: false,
        message: `"${fractionalItem.name || fractionalItem.id || 'Item'}" is billed in ${fractionalItem.unit || fractionalItem.saleUnit} — quantity must be a whole number.`
      });
    }
  }

  if (customerName !== undefined) order.customerName = customerName;
  if (customerPhone !== undefined) order.customerPhone = customerPhone;
  if (customerId !== undefined) order.customerId = customerId;
  if (customerGstin !== undefined) order.customerGstin = customerGstin;
  if (customerPan !== undefined) order.customerPan = customerPan;
  if (customerAddress !== undefined) order.customerAddress = customerAddress;
  if (customerState !== undefined) order.customerState = customerState;
  if (customerStateCode !== undefined) order.customerStateCode = customerStateCode;
  if (paymentMethod !== undefined) order.paymentMethod = paymentMethod;
  if (notes !== undefined) order.notes = notes;
  if (dueDate !== undefined) order.dueDate = dueDate;
  if (subtotal !== undefined) order.subtotal = r2(subtotal);
  if (tax !== undefined) order.tax = r2(tax);
  if (discount !== undefined) order.discount = r2(discount);
  if (roundOff !== undefined) order.roundOff = r2(roundOff);
  if (total !== undefined) order.total = r2(total);

  if (Array.isArray(items) && items.length > 0) {
    order.items = items.map((i) => {
      const product = findProductInStore(store, i);
      return {
        id: i.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        productId: i.productId || i.id,
        name: i.name,
        barcode: i.barcode || '',
        hsn: i.hsn || '',
        qty: Number(i.qty) || 1,
        unit: i.unit || 'pcs',
        price: Number(i.price) || 0,
        taxRate: Number(i.taxRate) || 0,
        discount: Number(i.discount) || 0,
        total: Number(i.total) || 0,
        baseQty: product ? baseQty(product, i) : (Number(i.qty) || 1)
      };
    });
  }

  res.json({
    success: true,
    message: `Draft Invoice #${order.orderId} updated.`,
    data: { ...order, company: store.settings.company, billing: store.settings.billing }
  });
});

/** Delete an Invoice (Draft, Unpaid, or Voided) */
router.delete('/orders/:orderId', (req, res) => {
  const store = req.tenantStore;
  const idx = (store.orders || []).findIndex((o) => o.orderId === req.params.orderId);
  if (idx < 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  const order = store.orders[idx];

  // If already issued (UNPAID, PARTIALLY_PAID, PAID, or VOID), unwind stock, accounting, and session drawer
  if (order.status !== 'DRAFT') {
    if (order.status !== 'VOID') {
      // 1. Restore stock
      (order.items || []).forEach((item) => {
        const product = findProductInStore(store, item);
        if (!product) return;

        const soldQty = baseQty(product, item);
        const isComposite = product.isComposite || product.productType === 'composite';
        const recipe = (store.recipes || []).find((r) => r.productId === product.id);
        const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

        if (isComposite && ingredients.length > 0) {
          const yieldQty = Number(recipe?.yieldQty) || Number(product.recipeYieldQty) || 1;
          ingredients.forEach((ing) => {
            const raw = store.products.find((p) => p.id === ing.productId || (p.name && ing.name && p.name.trim().toLowerCase() === ing.name.trim().toLowerCase()));
            if (!raw) return;
            const reqPerUnit = (Number(ing.qty) || 0) / yieldQty;
            const returned = Math.round(reqPerUnit * soldQty * 10000) / 10000;
            restoreWarehouseStock(raw, returned);

            logStockMovement(store, {
              product: raw,
              type: 'RETURN',
              qtyChange: returned,
              reason: `Deleted Invoice ${order.orderId} (Restored from ${product.name})`,
              refId: order.orderId,
              user: actor(req)
            });
          });
          return;
        }

        const isCombo = product.isCombo || product.productType === 'combo';
        const comboItems = product.comboItems || product.bundleItems || [];
        if (isCombo && comboItems.length > 0) {
          comboItems.forEach((ci) => {
            const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
            if (!comp) return;
            const compQty = Number(ci.qty || ci.quantity || 1);
            const returned = Math.round(compQty * soldQty * 10000) / 10000;
            restoreWarehouseStock(comp, returned);

            logStockMovement(store, {
              product: comp,
              type: 'RETURN',
              qtyChange: returned,
              reason: `Deleted Invoice ${order.orderId} (Restored from combo ${product.name})`,
              refId: order.orderId,
              user: actor(req)
            });
          });
          return;
        }

        restoreWarehouseStock(product, soldQty, item.batchesSold, item.serialId);

        logStockMovement(store, {
          product,
          type: 'RETURN',
          qtyChange: soldQty,
          reason: `Deleted Invoice ${order.orderId}`,
          refId: order.orderId,
          user: actor(req)
        });
      });

      // 2. Reverse accounting journal vouchers
      (store.journal || [])
        .filter((v) => v.refId === order.orderId && !v.isReversed && !v.reversalOf)
        .forEach((v) => {
          try {
            engine.reverseJournal(store, v.id, actor(req));
          } catch (err) {
            // "Already reversed" is expected when another voucher in this chain already reversed it; anything else would leave stock/status changed but the ledger un-reversed untraced.
            if (err.message !== 'Voucher has already been reversed.') {
              console.error(`[Delete Invoice ${order.orderId}] Failed to reverse voucher ${v.id}:`, err.message);
            }
          }
        });

      // 3. Deduct any cash received from active session drawer
      const paidCash = (order.payments || [])
        .filter((p) => String(p.paymentMethod).toLowerCase() === 'cash')
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0) || (order.paymentMethod === 'Cash' ? Number(order.paidAmount || 0) : 0);

      if (paidCash > 0 && store.session) {
        store.session.currentCash = r2(store.session.currentCash - paidCash);
        store.session.cashEntries.push({
          type: 'OUT',
          amount: paidCash,
          reason: `Delete Invoice ${order.orderId}`,
          time: new Date().toISOString()
        });
      }

      // 4. Unwind customer loyalty and resync customer accounts
      const customer = (store.customers || []).find((c) => c.id === order.customerId);
      if (customer) {
        const balance = (customer.loyaltyPoints || 0) - (order.loyaltyEarned || 0) + (order.pointsRedeemed || 0);
        customer.loyaltyPoints = Math.max(0, balance);

        const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
        if (account) {
          const currentBal = engine.accountBalance(store, account.id);
          customer.outstanding = Math.max(0, currentBal);
          customer.advance = Math.max(0, -currentBal);
        }
      }
    }
  }

  store.orders.splice(idx, 1);
  res.json({ success: true, message: `Invoice #${order.orderId} deleted and inventory stock restored.` });
});

/** Void a completed bill: restore stock and reverse every related voucher. */
router.post('/orders/:orderId/void', (req, res) => {
  const store = req.tenantStore;
  const order = store.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (order.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Invoice is already voided.' });
  }

  order.items.forEach((item) => {
    const product = findProductInStore(store, item);
    if (!product) return;

    const soldQty = baseQty(product, item);
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      const yieldQty = Number(recipe?.yieldQty) || Number(product.recipeYieldQty) || 1;
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId || (p.name && ing.name && p.name.trim().toLowerCase() === ing.name.trim().toLowerCase()));
        if (!raw) return;
        const reqPerUnit = (Number(ing.qty) || 0) / yieldQty;
        const returned = Math.round(reqPerUnit * soldQty * 10000) / 10000;
        restoreWarehouseStock(raw, returned);

        logStockMovement(store, {
          product: raw,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Void of ${order.orderId} (Restored from ${product.name})`,
          refId: order.orderId,
          user: actor(req)
        });
      });
      return;
    }

    const isCombo = product.isCombo || product.productType === 'combo';
    const comboItems = product.comboItems || product.bundleItems || [];
    if (isCombo && comboItems.length > 0) {
      comboItems.forEach((ci) => {
        const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
        if (!comp) return;
        const compQty = Number(ci.qty || ci.quantity || 1);
        const returned = Math.round(compQty * soldQty * 10000) / 10000;
        restoreWarehouseStock(comp, returned);

        logStockMovement(store, {
          product: comp,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Void of ${order.orderId} (Restored from combo ${product.name})`,
          refId: order.orderId,
          user: actor(req)
        });
      });
      return;
    }

    restoreWarehouseStock(product, soldQty, item.batchesSold, item.serialId);

    logStockMovement(store, {
      product,
      type: 'RETURN',
      qtyChange: soldQty,
      reason: `Void of ${order.orderId}`,
      refId: order.orderId,
      user: actor(req)
    });
  });

  const reversed = [];
  (store.journal || [])
    .filter((v) => v.refId === order.orderId && !v.isReversed && !v.reversalOf)
    .forEach((v) => {
      try {
        reversed.push(engine.reverseJournal(store, v.id, actor(req)).voucherNo);
      } catch (err) {
        // "Already reversed" is expected when another voucher in this chain already reversed it; anything else would leave stock restored but the ledger un-reversed untraced.
        if (err.message !== 'Voucher has already been reversed.') {
          console.error(`[Void ${order.orderId}] Failed to reverse voucher ${v.id}:`, err.message);
        }
      }
    });

  // Deduct only the cash actually collected, not the full total — a partial order tagged paymentMethod:'Cash' would otherwise pull cash never physically received. Mirrors DELETE /orders/:orderId.
  const paidCash = (order.payments || [])
    .filter((p) => String(p.paymentMethod).toLowerCase() === 'cash')
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0) || (order.paymentMethod === 'Cash' ? Number(order.paidAmount || 0) : 0);

  if (paidCash > 0 && store.session) {
    store.session.currentCash = r2(store.session.currentCash - paidCash);
    store.session.cashEntries.push({
      type: 'OUT',
      amount: paidCash,
      reason: `Void ${order.orderId}`,
      time: new Date().toISOString()
    });
  }

  // Unwind loyalty in both directions: take back what the bill earned and give
  // back what it consumed, so a void leaves the customer exactly where they were.
  const customer = (store.customers || []).find((c) => c.id === order.customerId);
  if (customer) {
    const balance = (customer.loyaltyPoints || 0) - (order.loyaltyEarned || 0) + (order.pointsRedeemed || 0);
    customer.loyaltyPoints = Math.max(0, balance);

    // The journal reversal above already moved the ledger back; resync cached outstanding/advance so a later advance-redemption check doesn't trust stale pre-void figures (mirrors /purchases/:id/void).
    const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
    if (account) {
      const currentBal = engine.accountBalance(store, account.id);
      customer.outstanding = Math.max(0, currentBal);
      customer.advance = Math.max(0, -currentBal);
    }
  }

  order.status = 'VOID';
  order.voidedBy = actor(req);
  order.voidedAt = new Date().toISOString();

  res.json({ success: true, message: `Invoice ${order.orderId} voided.`, data: { order, reversed } });
});

/* -------------------------------- credit notes (sales returns) -------------------------------- */

// Sales Credit Note — returns part of an invoice without voiding it all. Mirrors /purchases/:id/return: restores stock and posts a real reversing journal entry rather than silently adjusting numbers.
router.post('/orders/:orderId/return', (req, res) => {
  const store = req.tenantStore;
  const order = store.orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (order.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'Cannot return items from a voided invoice.' });
  }
  if (order.status === 'DRAFT') {
    return res.status(400).json({ success: false, message: 'This invoice has not been issued yet.' });
  }

  const { items, reason, date } = req.body;
  const requested = (Array.isArray(items) ? items : []).filter((l) => Number(l.qty) > 0);
  if (!requested.length) {
    return res.status(400).json({ success: false, message: 'Select at least one item to return.' });
  }

  const customer = order.customerId ? (store.customers || []).find((c) => c.id === order.customerId) : null;

  // FEFO can spread one order line across several batches, so — unlike vendor credits — returns are tracked per product line, restoring into the line's own recorded batchesSold below.
  const alreadyCredited = (productId) =>
    (store.creditNotes || [])
      .filter((cn) => cn.orderId === order.orderId && cn.status !== 'VOID')
      .reduce(
        (sum, cn) => sum + (cn.items || []).filter((it) => it.productId === productId).reduce((s, it) => s + Number(it.qty || 0), 0),
        0
      );

  // Pass 1: validate every requested line before mutating anything.
  const plan = [];
  for (const reqLine of requested) {
    const qty = r2(Number(reqLine.qty));
    const orderLine = (order.items || []).find((ol) => ol.id === reqLine.productId);
    if (!orderLine) {
      return res.status(400).json({ success: false, message: 'No matching line found on this invoice for the selected item.' });
    }
    const product = findProductInStore(store, orderLine);
    if (!product) {
      return res.status(400).json({ success: false, message: `${orderLine.name}: product no longer exists in the catalogue.` });
    }

    const maxReturnable = r2(Number(orderLine.qty) - alreadyCredited(orderLine.id));
    if (!(qty > 0) || qty > maxReturnable + 0.009) {
      return res.status(400).json({
        success: false,
        message: `${orderLine.name}: enter a quantity between 0 and ${maxReturnable} ${orderLine.unit || ''} (already returned reduces what's returnable).`
      });
    }

    plan.push({ product, orderLine, qty });
  }

  // Pass 2: apply — same composite/combo/batch unwind logic as a full void,
  // just scaled to the returned quantity instead of the whole sold quantity.
  const creditLines = [];
  plan.forEach(({ product, orderLine, qty }) => {
    const baseQtyToRestore = baseQty(product, { unit: orderLine.unit, qty });
    const isComposite = product.isComposite || product.productType === 'composite';
    const recipe = (store.recipes || []).find((r) => r.productId === product.id);
    const ingredients = recipe?.ingredients || product.recipe?.ingredients || product.recipeItems || [];

    if (isComposite && ingredients.length > 0) {
      const yieldQty = Number(recipe?.yieldQty) || Number(product.recipeYieldQty) || 1;
      ingredients.forEach((ing) => {
        const raw = store.products.find((p) => p.id === ing.productId || (p.name && ing.name && p.name.trim().toLowerCase() === ing.name.trim().toLowerCase()));
        if (!raw) return;
        const reqPerUnit = (Number(ing.qty) || 0) / yieldQty;
        const returned = r2(reqPerUnit * baseQtyToRestore);
        restoreWarehouseStock(raw, returned);
        logStockMovement(store, {
          product: raw,
          type: 'RETURN',
          qtyChange: returned,
          reason: `Customer return of ${product.name} (Invoice ${order.orderId})`,
          refId: order.orderId,
          user: actor(req)
        });
      });
    } else {
      const isCombo = product.isCombo || product.productType === 'combo';
      const comboItems = product.comboItems || product.bundleItems || [];
      if (isCombo && comboItems.length > 0) {
        comboItems.forEach((ci) => {
          const comp = store.products.find((p) => p.id === ci.productId || p.id === ci.id);
          if (!comp) return;
          const compQty = Number(ci.qty || ci.quantity || 1);
          const returned = r2(compQty * baseQtyToRestore);
          restoreWarehouseStock(comp, returned);
          logStockMovement(store, {
            product: comp,
            type: 'RETURN',
            qtyChange: returned,
            reason: `Customer return via combo ${product.name} (Invoice ${order.orderId})`,
            refId: order.orderId,
            user: actor(req)
          });
        });
      } else {
        // Restore into the exact batches this line originally drew from, in order, up to the returned quantity — a fresh FEFO pick would put stock into the wrong lot.
        let partialBatchesSold;
        if (product.trackBatches && Array.isArray(orderLine.batchesSold) && orderLine.batchesSold.length) {
          let remaining = baseQtyToRestore;
          partialBatchesSold = [];
          for (const b of orderLine.batchesSold) {
            if (remaining <= 0) break;
            const take = Math.min(Number(b.qty) || 0, remaining);
            if (take <= 0) continue;
            partialBatchesSold.push({ batchId: b.batchId, batchNo: b.batchNo, qty: take });
            remaining = r2(remaining - take);
          }
        }
        restoreWarehouseStock(product, baseQtyToRestore, partialBatchesSold);
        logStockMovement(store, {
          product,
          type: 'RETURN',
          qtyChange: baseQtyToRestore,
          reason: `Customer return (Invoice ${order.orderId})`,
          refId: order.orderId,
          user: actor(req)
        });
      }
    }

    const rate = Number(orderLine.price || 0);
    const taxRate = Number(orderLine.taxRate || 0);
    const lineSubtotal = r2(qty * rate);
    const lineTax = r2((lineSubtotal * taxRate) / 100);
    creditLines.push({
      productId: orderLine.id,
      name: orderLine.name,
      unit: orderLine.unit || product.unit,
      qty,
      baseQty: baseQtyToRestore,
      rate,
      taxRate,
      costPrice: Number(product.purchasePrice || 0),
      lineSubtotal,
      lineTax,
      lineTotal: r2(lineSubtotal + lineTax)
    });
  });

  const subtotal = r2(creditLines.reduce((s, l) => s + l.lineSubtotal, 0));
  const tax = r2(creditLines.reduce((s, l) => s + l.lineTax, 0));
  const totalAmount = r2(subtotal + tax);

  const creditNote = {
    id: `cn_${Date.now()}`,
    orderId: order.orderId,
    customerId: order.customerId || null,
    customerName: order.customerName || 'Walk-in Customer',
    date: date || new Date().toISOString(),
    reason: reason || 'Sales Return',
    items: creditLines,
    subtotal,
    tax,
    totalAmount,
    status: 'ACTIVE',
    createdBy: actor(req),
    createdAt: new Date().toISOString()
  };

  try {
    const result = posting.postSalesReturn(store, creditNote, {
      customer,
      interState: store.settings.tax.interState,
      createdBy: actor(req)
    });
    creditNote.voucherId = result.voucher.id;
    creditNote.voucherNo = result.voucher.voucherNo;
  } catch (err) {
    creditNote.accountingError = err.message;
  }

  if (customer) {
    const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
    if (account) {
      const bal = engine.accountBalance(store, account.id);
      customer.outstanding = Math.max(0, bal);
      customer.advance = Math.max(0, -bal);
    }
  }

  if (!Array.isArray(store.creditNotes)) store.creditNotes = [];
  store.creditNotes.unshift(creditNote);

  res.status(201).json({
    success: true,
    message: `Returned ${creditLines.length} item(s) from ${order.customerName || 'customer'}. Credited ₹${totalAmount.toFixed(2)}.`,
    data: creditNote
  });
});

router.get('/credit-notes', (req, res) => {
  const store = req.tenantStore;
  const { customerId, orderId, from, to } = req.query;

  let rows = [...(store.creditNotes || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (customerId) rows = rows.filter((v) => v.customerId === customerId);
  if (orderId) rows = rows.filter((v) => v.orderId === orderId);
  if (from) rows = rows.filter((v) => engine.dayKey(v.date) >= engine.dayKey(from));
  if (to) rows = rows.filter((v) => engine.dayKey(v.date) <= engine.dayKey(to));

  const active = rows.filter((v) => v.status !== 'VOID');

  res.json({
    success: true,
    data: rows,
    summary: { count: active.length, total: r2(active.reduce((s, v) => s + (Number(v.totalAmount) || 0), 0)) }
  });
});

/** Voids a credit note: restores the returned stock/batch and reverses the journal entry. */
router.post('/credit-notes/:id/void', (req, res) => {
  const store = req.tenantStore;
  const cn = (store.creditNotes || []).find((v) => v.id === req.params.id);
  if (!cn) return res.status(404).json({ success: false, message: 'Credit note not found.' });
  if (cn.status === 'VOID') {
    return res.status(400).json({ success: false, message: 'This credit note is already voided.' });
  }

  (cn.items || []).forEach((line) => {
    const product = store.products.find((p) => p.id === line.productId);
    if (!product) return;
    const qty = Number(line.baseQty ?? line.qty) || 0;
    if (qty <= 0) return;

    if (product.trackBatches) {
      // Take the same amount back out via FEFO — it can't be traced to one
      // specific batch once it's merged back into the pool.
      consumeBatchesFEFO(product, qty);
    } else {
      product.stock = r2(Number(product.stock || 0) - qty);
      if (product.warehouses && typeof product.warehouses === 'object') {
        const whKey = product.warehouses.wh_shop !== undefined ? 'wh_shop' : (Object.keys(product.warehouses)[0] || 'wh_main');
        product.warehouses[whKey] = r2((Number(product.warehouses[whKey]) || 0) - qty);
        product.stock = r2(Object.values(product.warehouses).reduce((sum, val) => sum + Number(val || 0), 0));
      }
    }

    logStockMovement(store, {
      product,
      type: 'SALE',
      qtyChange: -qty,
      reason: `Void of customer return — ${cn.orderId || ''}`,
      refId: cn.id,
      user: actor(req)
    });
  });

  (store.journal || [])
    .filter((v) => v.refId === cn.id && !v.isReversed && !v.reversalOf)
    .forEach((v) => {
      try {
        engine.reverseJournal(store, v.id, actor(req));
      } catch (err) {
        if (err.message !== 'Voucher has already been reversed.') {
          console.error(`[Void credit note ${cn.id}] Failed to reverse voucher ${v.id}:`, err.message);
        }
      }
    });

  if (cn.customerId) {
    const customer = store.customers.find((c) => c.id === cn.customerId);
    const account = (store.accounts || []).find((a) => a.partyId === cn.customerId && a.partyType === 'CUSTOMER');
    if (customer && account) {
      const bal = engine.accountBalance(store, account.id);
      customer.outstanding = Math.max(0, bal);
      customer.advance = Math.max(0, -bal);
    }
  }

  cn.status = 'VOID';
  cn.voidedBy = actor(req);
  cn.voidedAt = new Date().toISOString();

  res.json({ success: true, message: 'Credit note voided; returned stock reversed.', data: cn });
});

/* --------------------------------- session --------------------------------- */

router.get('/session', (req, res) => {
  res.json({ success: true, data: req.tenantStore.session });
});

router.get('/sessions', (req, res) => {
  res.json({ success: true, data: req.tenantStore.sessions || [] });
});

const DENOM_VALUES = { '2000': 2000, '500': 500, '200': 200, '100': 100, '50': 50, '20': 20, '10': 10, coins: 1 };
const denomTotal = (d) => {
  if (!d || typeof d !== 'object') return 0;
  return Object.keys(DENOM_VALUES).reduce((sum, k) => sum + (Number(d[k]) || 0) * DENOM_VALUES[k], 0);
};

// Records a lump-sum locker movement from a counter open/close (exact notes aren't known then); the note-by-note breakdown is reconciled separately via POST /company-locker/recount.
function moveLockerCash(store, { type, amount, sessionId, note, user }) {
  const value = r2(Math.abs(Number(amount) || 0));
  if (value <= 0) return;
  if (!store.companyLocker) {
    store.companyLocker = { balance: 0, denominations: { '2000': 0, '500': 0, '200': 0, '100': 0, '50': 0, '20': 0, '10': 0, coins: 0 }, history: [] };
  }
  store.companyLocker.balance = r2((store.companyLocker.balance || 0) + (type === 'DEPOSIT' ? value : -value));
  if (!Array.isArray(store.companyLocker.history)) store.companyLocker.history = [];
  store.companyLocker.history.unshift({
    id: `lock_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    type,
    amount: value,
    balanceAfter: store.companyLocker.balance,
    sessionId: sessionId || null,
    note: note || '',
    user: user || 'Owner',
    date: new Date().toISOString()
  });
  if (store.companyLocker.history.length > 500) store.companyLocker.history.pop();
}

router.get('/company-locker', (req, res) => {
  const store = req.tenantStore;
  const locker = store.companyLocker || { balance: 0, denominations: {}, history: [] };
  res.json({ success: true, data: locker });
});

// Physical recount: the owner counts actual notes/coins in the safe — the one place the locker's note-by-note breakdown, not just its lump balance, is ever authoritative.
router.post('/company-locker/recount', (req, res) => {
  const store = req.tenantStore;
  const denominations = req.body.denominations || null;
  if (!denominations || typeof denominations !== 'object') {
    return res.status(400).json({ success: false, message: 'Enter the note and coin counts to record.' });
  }
  if (!store.companyLocker) {
    store.companyLocker = { balance: 0, denominations: {}, history: [] };
  }
  const newTotal = r2(denomTotal(denominations));
  const oldBalance = r2(store.companyLocker.balance || 0);
  const variance = r2(newTotal - oldBalance);

  store.companyLocker.balance = newTotal;
  store.companyLocker.denominations = denominations;
  if (!Array.isArray(store.companyLocker.history)) store.companyLocker.history = [];
  store.companyLocker.history.unshift({
    id: `lock_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    type: 'RECOUNT',
    amount: newTotal,
    variance,
    balanceAfter: newTotal,
    sessionId: null,
    note: req.body.notes || 'Physical recount',
    user: actor(req),
    date: new Date().toISOString()
  });
  if (store.companyLocker.history.length > 500) store.companyLocker.history.pop();

  res.json({
    success: true,
    message: `Locker recount saved. ${variance === 0 ? 'Matched previous balance.' : variance > 0 ? `+₹${variance.toFixed(2)} more than expected.` : `−₹${Math.abs(variance).toFixed(2)} less than expected.`}`,
    data: store.companyLocker
  });
});

router.post('/session/open', (req, res) => {
  const store = req.tenantStore;
  const denominations = req.body.denominations || null;
  const ownerDenominations = req.body.ownerDenominations || null;

  // Opening float is split between company cash (drawn from the locker) and the owner's personal contribution; each side accepts either an explicit amount or a denomination breakdown, and openingCash is always their sum (mirrors ownerCashTaken/companyCashRemaining at close).
  const companyCashInput = req.body.companyCashInput !== undefined
    ? r2(Math.max(0, Number(req.body.companyCashInput) || 0))
    : (denominations && typeof denominations === 'object' ? r2(denomTotal(denominations)) : null);
  const ownerCashInput = req.body.ownerCashInput !== undefined
    ? r2(Math.max(0, Number(req.body.ownerCashInput) || 0))
    : (ownerDenominations && typeof ownerDenominations === 'object' ? r2(denomTotal(ownerDenominations)) : null);

  let openingCash = Number(req.body.openingCash) || 0;
  if (!openingCash && (companyCashInput !== null || ownerCashInput !== null)) {
    openingCash = r2((companyCashInput || 0) + (ownerCashInput || 0));
  }

  const lockerBalance = r2(store.companyLocker?.balance || 0);
  if (companyCashInput > lockerBalance + 0.009) {
    return res.status(400).json({
      success: false,
      message: `Company Locker only has ₹${lockerBalance.toFixed(2)} available — can't draw ₹${companyCashInput.toFixed(2)} from it.`
    });
  }

  const sessionId = `sess_${Date.now()}`;

  store.session = {
    id: sessionId,
    status: 'open',
    openedAt: new Date().toISOString(),
    openedBy: req.body.user || actor(req),
    openingCash: r2(openingCash),
    currentCash: r2(openingCash),
    openingDenominations: denominations,
    ownerDenominations,
    companyCashInput,
    ownerCashInput,
    cashEntries: []
  };

  if (companyCashInput > 0) {
    moveLockerCash(store, {
      type: 'WITHDRAWAL',
      amount: companyCashInput,
      sessionId,
      note: 'Counter opening float',
      user: req.body.user || actor(req)
    });
  }

  res.json({ success: true, message: 'POS counter session opened.', data: store.session });
});

router.post('/session/close', (req, res) => {
  const store = req.tenantStore;
  if (!store.session || store.session.status === 'closed') {
    return res.status(400).json({ success: false, message: 'No open session to close.' });
  }

  const denominations = req.body.closingDenominations || req.body.denominations || null;
  let countedCash = req.body.countedCash !== undefined ? Number(req.body.countedCash) : store.session.currentCash;

  if (denominations && typeof denominations === 'object') {
    const dTotal =
      (Number(denominations['2000'] || 0) * 2000) +
      (Number(denominations['500'] || 0) * 500) +
      (Number(denominations['200'] || 0) * 200) +
      (Number(denominations['100'] || 0) * 100) +
      (Number(denominations['50'] || 0) * 50) +
      (Number(denominations['20'] || 0) * 20) +
      (Number(denominations['10'] || 0) * 10) +
      (Number(denominations['coins'] || 0));
    countedCash = dTotal;
  }

  const sessionOrders = (store.orders || []).filter((o) => o.sessionId === store.session.id && o.status !== 'VOID');

  // Split so a shop can reconcile the owner's take separately, rather than one lump "counted cash" that hides whether the owner walked off with part of it.
  const ownerCashTaken = r2(Math.max(0, Number(req.body.ownerCashTaken) || 0));
  const companyCashRemaining = r2(Math.max(0, countedCash - ownerCashTaken));

  Object.assign(store.session, {
    status: 'closed',
    closedAt: new Date().toISOString(),
    closedBy: req.body.user || actor(req),
    countedCash: r2(countedCash),
    ownerCashTaken,
    companyCashRemaining,
    closingDenominations: denominations,
    expectedCash: r2(store.session.currentCash),
    variance: r2(countedCash - store.session.currentCash),
    billCount: sessionOrders.length,
    salesTotal: r2(sessionOrders.reduce((s, o) => s + (o.total || 0), 0)),
    notes: req.body.notes || ''
  });

  if (companyCashRemaining > 0) {
    moveLockerCash(store, {
      type: 'DEPOSIT',
      amount: companyCashRemaining,
      sessionId: store.session.id,
      note: 'Counter closing — remainder stored',
      user: req.body.user || actor(req)
    });
  }

  store.sessions.unshift({ ...store.session });

  res.json({ success: true, message: 'POS counter session closed.', data: store.session });
});

router.post('/session/cash-entry', async (req, res) => {
  const store = req.tenantStore;
  const { type, amount, reason, person, phone, address, purpose, classification, expenseCategory, accountId, vendorId, customerId, partyType } = req.body;
  const value = Number(amount);
  if (!value) return res.status(400).json({ success: false, message: 'Amount is required.' });
  if (!store.session || store.session.status !== 'open') {
    return res.status(400).json({ success: false, message: 'Open a counter session first.' });
  }

  const isExpense = classification === 'EXPENSE' || type === 'EXPENSE';
  const effectiveType = isExpense ? 'OUT' : (type === 'IN' ? 'IN' : 'OUT');

  store.session.currentCash = r2(
    effectiveType === 'IN'
      ? store.session.currentCash + value
      : store.session.currentCash - value
  );

  let customerObj = null;
  if (customerId || partyType === 'CUSTOMER') {
    customerObj = (store.customers || []).find((c) => c.id === customerId || (c.name && person && c.name.toLowerCase() === person.toLowerCase())) || null;
  }

  let vendorObj = null;
  if (vendorId || classification === 'VENDOR_REPAY' || partyType === 'VENDOR') {
    vendorObj = (store.vendors || []).find((v) => v.id === vendorId || (v.name && person && v.name.toLowerCase() === person.toLowerCase())) || null;
  }

  // No "unofficial" cash: an unknown payer gets turned into a real customer (matched by phone if seen before) so the money always has a party and ledger account, not just a free-text name.
  let newlyCreatedCustomer = false;
  if (!customerObj && !vendorObj && partyType === 'OTHER' && effectiveType === 'IN' && String(phone || '').trim()) {
    const cleanPhone = String(phone).trim();
    customerObj = (store.customers || []).find((c) => c.phone && String(c.phone).trim() === cleanPhone) || null;
    if (!customerObj) {
      customerObj = {
        id: `c_${Date.now()}`,
        name: (person || 'Walk-in Customer').trim(),
        phone: cleanPhone,
        email: '',
        address: (address || '').trim(),
        group: 'Retail',
        creditLimit: 0,
        gstin: '',
        pan: '',
        state: '',
        stateCode: '',
        priceSheetId: null,
        outstanding: 0,
        advance: 0,
        loyaltyPoints: 0,
        createdAt: new Date().toISOString(),
        source: 'CASH_COUNTER'
      };
      store.customers.push(customerObj);
      engine.ensurePartyAccount(store, customerObj, 'CUSTOMER');
      newlyCreatedCustomer = true;
      try {
        await savePartyToDb(req.tenantDbName, { ...customerObj, type: 'customer' });
      } catch (err) {
        /* the cash entry and in-memory customer still stand even if the
           background persist fails — it'll be picked up on the next save */
      }
    }
  }

  const resolvedPerson = customerObj ? customerObj.name : (vendorObj ? vendorObj.name : person) || '';
  const resolvedPartyType = customerObj ? 'CUSTOMER' : (vendorObj ? 'VENDOR' : (partyType || 'OTHER'));
  const resolvedPhone = customerObj ? (customerObj.phone || '') : (vendorObj ? (vendorObj.phone || '') : (phone || ''));
  const resolvedAddress = customerObj ? (customerObj.address || '') : (vendorObj ? (vendorObj.address || '') : (address || ''));

  const entry = {
    id: `ce_${Date.now()}`,
    type: effectiveType,
    amount: value,
    classification: isExpense
      ? 'EXPENSE'
      : newlyCreatedCustomer
      ? 'NEW_CUSTOMER_ENTRY'
      : customerObj
      ? 'CUSTOMER_ENTRY'
      : vendorObj
      ? (effectiveType === 'IN' ? 'VENDOR_REPAY' : 'VENDOR_PAYMENT')
      : 'OFFICIAL',
    partyType: resolvedPartyType,
    person: resolvedPerson,
    phone: resolvedPhone,
    address: resolvedAddress,
    customerId: customerObj ? customerObj.id : null,
    vendorId: vendorObj ? vendorObj.id : null,
    isNewCustomer: newlyCreatedCustomer,
    purpose: purpose || reason || (isExpense ? 'Internal business expense' : newlyCreatedCustomer ? `New customer cash receipt (${resolvedPerson})` : customerObj ? `Customer ${effectiveType === 'IN' ? 'Receipt' : 'Refund'}` : vendorObj ? `Vendor ${effectiveType === 'IN' ? 'Repayment/Refund' : 'Payment'}` : `Cash ${effectiveType}`),
    expenseCategory: expenseCategory || (isExpense ? 'General' : null),
    reason: reason || purpose || `Cash ${effectiveType}`,
    time: new Date().toISOString(),
    user: actor(req)
  };

  store.session.cashEntries.push(entry);

  let voucherNo = null;
  // Every cash movement posts to the double-entry ledger — no "unofficial" bucket skips the books.
  try {
    const cash = engine.bySystemKey(store, 'CASH');
    if (customerObj && effectiveType === 'IN') {
      // Customer Paying Into Drawer (Receipt / Settlement)
      const voucher = posting.postReceipt(
        store,
        {
          id: `rec_${Date.now()}`,
          date: new Date().toISOString(),
          amount: value,
          discount: 0,
          paymentMode: 'Cash',
          notes: `${entry.purpose} (Customer: ${customerObj.name})`
        },
        { customer: customerObj, createdBy: actor(req) }
      );
      voucherNo = voucher.voucherNo;
      if (customerObj.outstanding !== undefined) {
        customerObj.outstanding = r2((customerObj.outstanding || 0) - value);
      }
    } else if (vendorObj && effectiveType === 'IN') {
      // Vendor Repayment / Refund Into Drawer
      const voucher = posting.postVendorRefund(store, {
        amount: value,
        vendor: vendorObj,
        notes: `${entry.purpose} (Vendor: ${vendorObj.name})`,
        createdBy: actor(req)
      });
      voucherNo = voucher.voucherNo;
    } else if (vendorObj && effectiveType === 'OUT') {
      // Vendor Cash Payout From Drawer
      const voucher = posting.postPayment(
        store,
        {
          id: `pay_${Date.now()}`,
          date: new Date().toISOString(),
          amount: value,
          discount: 0,
          paymentMode: 'Cash',
          notes: `${entry.purpose} (Vendor: ${vendorObj.name})`
        },
        { vendor: vendorObj, createdBy: actor(req) }
      );
      voucherNo = voucher.voucherNo;
      if (vendorObj.outstanding !== undefined) {
        vendorObj.outstanding = r2((vendorObj.outstanding || 0) - value);
      }
    } else if (isExpense) {
      const expenseAcc = (store.accounts || []).find((a) => a.type === 'EXPENSE' && !a.isGroup);
      const voucher = posting.postExpense(
        store,
        {
          id: `exp_${Date.now()}`,
          accountId: expenseAcc?.id,
          systemKey: expenseAcc ? undefined : 'STORE_SUPPLIES',
          amount: value,
          tax: 0,
          paymentMode: 'Cash',
          notes: `${expenseCategory ? `[${expenseCategory}] ` : ''}${entry.purpose} (Recipient: ${person || 'N/A'})`,
          date: new Date().toISOString()
        },
        { createdBy: actor(req) }
      );
      voucherNo = voucher.voucherNo;
    } else {
      const bank = (store.accounts || []).find((a) => a.systemKey === 'BANK');
      // No customer/vendor/expense and no explicit or bank account — treat as the owner's own capital injection (IN) or drawing (OUT) so it always reaches the books rather than silently skipping the ledger.
      const equityFallback = engine.bySystemKey(store, effectiveType === 'IN' ? 'CAPITAL' : 'DRAWINGS');
      const counter = accountId ? engine.resolveAccount(store, accountId) : (bank || equityFallback);
      if (counter && counter.id !== cash.id) {
        const voucher = posting.postFundTransfer(
          store,
          {
            id: `cashentry_${Date.now()}`,
            fromAccountId: effectiveType === 'IN' ? counter.id : cash.id,
            toAccountId: effectiveType === 'IN' ? cash.id : counter.id,
            amount: value,
            charges: 0,
            notes: `${entry.purpose}${person ? ` (Person: ${person})` : ''}`,
            date: new Date().toISOString()
          },
          { createdBy: actor(req) }
        );
        voucherNo = voucher.voucherNo;
      }
    }
  } catch (err) {
    // The drawer entry still stands even if double-entry posting fails, but log it — a silently-null voucherNo previously hid a real bug here.
    console.error('[session/cash-entry] ledger posting failed:', err.message);
  }

  res.json({
    success: true,
    message: newlyCreatedCustomer
      ? `Cash ${effectiveType} recorded — ${customerObj.name} added to Customers.`
      : `${entry.classification === 'EXPENSE' ? 'Expense' : 'Cash'} ${effectiveType} recorded.`,
    data: { session: store.session, entry, voucherNo, customer: newlyCreatedCustomer ? customerObj : undefined }
  });
});

/* --------------------------------- tables --------------------------------- */

router.get('/tables', (req, res) => {
  const store = req.tenantStore;
  res.json({
    success: true,
    data: (store.tables || []).map((t) => ({
      ...t,
      bill: (store.heldBills || []).find((h) => h.id === t.currentBillId) || null
    }))
  });
});

router.post('/tables', (req, res) => {
  const { name, area, seats } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Table name is required.' });
  const table = {
    id: `tbl_${Date.now()}`,
    name,
    area: area || 'Main',
    seats: Number(seats) || 4,
    status: 'FREE',
    currentBillId: null,
    occupiedAt: null
  };
  req.tenantStore.tables.push(table);
  res.status(201).json({ success: true, data: table });
});

router.put('/tables/:id', (req, res) => {
  const table = (req.tenantStore.tables || []).find((t) => t.id === req.params.id);
  if (!table) return res.status(404).json({ success: false, message: 'Table not found.' });
  Object.assign(table, req.body, { id: table.id });
  res.json({ success: true, data: table });
});

router.delete('/tables/:id', (req, res) => {
  const store = req.tenantStore;
  const table = (store.tables || []).find((t) => t.id === req.params.id);
  if (table && table.status === 'OCCUPIED') {
    return res.status(400).json({ success: false, message: 'Cannot delete an occupied table.' });
  }
  store.tables = (store.tables || []).filter((t) => t.id !== req.params.id);
  res.json({ success: true, message: 'Table removed.' });
});

/** Move a running bill from one table to another. */
router.post('/tables/transfer', (req, res) => {
  const store = req.tenantStore;
  const { fromTableId, toTableId } = req.body;
  const from = (store.tables || []).find((t) => t.id === fromTableId);
  const to = (store.tables || []).find((t) => t.id === toTableId);

  if (!from || !to) return res.status(404).json({ success: false, message: 'Table not found.' });
  if (to.status === 'OCCUPIED') {
    return res.status(400).json({ success: false, message: `${to.name} is already occupied — merge instead.` });
  }

  const bill = (store.heldBills || []).find((h) => h.id === from.currentBillId);
  if (bill) bill.tableId = to.id;

  Object.assign(to, { status: from.status, currentBillId: from.currentBillId, occupiedAt: from.occupiedAt });
  Object.assign(from, { status: 'FREE', currentBillId: null, occupiedAt: null });

  res.json({ success: true, message: `Bill transferred from ${from.name} to ${to.name}.`, data: { from, to } });
});

/** Merge two running tables into a single bill. */
router.post('/tables/merge', (req, res) => {
  const store = req.tenantStore;
  const { sourceTableId, targetTableId } = req.body;
  const source = (store.tables || []).find((t) => t.id === sourceTableId);
  const target = (store.tables || []).find((t) => t.id === targetTableId);

  if (!source || !target) return res.status(404).json({ success: false, message: 'Table not found.' });

  const sourceBill = (store.heldBills || []).find((h) => h.id === source.currentBillId);
  const targetBill = (store.heldBills || []).find((h) => h.id === target.currentBillId);

  if (!sourceBill || !targetBill) {
    return res.status(400).json({ success: false, message: 'Both tables must have a running bill to merge.' });
  }

  sourceBill.items.forEach((item) => {
    const existing = targetBill.items.find((i) => i.id === item.id);
    if (existing) {
      existing.qty = r2(existing.qty + item.qty);
      existing.total = r2(existing.qty * existing.price);
    } else {
      targetBill.items.push(item);
    }
  });
  targetBill.total = r2(targetBill.items.reduce((s, i) => s + i.total, 0));
  targetBill.notes = `${targetBill.notes} · merged ${source.name}`;

  store.heldBills = store.heldBills.filter((h) => h.id !== sourceBill.id);
  Object.assign(source, { status: 'FREE', currentBillId: null, occupiedAt: null });

  res.json({ success: true, message: `${source.name} merged into ${target.name}.`, data: targetBill });
});

// Quotations / Estimates

router.get('/quotations', (req, res) => {
  const store = req.tenantStore;
  const { q, status, limit } = req.query;

  let rows = [...(store.quotations || [])];
  rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (status && status !== 'ALL') rows = rows.filter((qt) => qt.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (qt) =>
        (qt.quotationNo || '').toLowerCase().includes(needle) ||
        (qt.customerName || '').toLowerCase().includes(needle) ||
        (qt.customerPhone || '').includes(needle)
    );
  }

  res.json({ success: true, data: rows.slice(0, Number(limit) || 500), count: rows.length });
});

router.get('/quotations/:id', (req, res) => {
  const store = req.tenantStore;
  const quotation = (store.quotations || []).find((qt) => qt.id === req.params.id || qt.quotationNo === req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });

  res.json({
    success: true,
    data: { ...quotation, company: store.settings.company, billing: store.settings.billing }
  });
});

router.post('/quotations', (req, res) => {
  const store = req.tenantStore;
  const {
    customerId,
    customerName,
    customerPhone,
    customerGstin,
    customerAddress,
    items,
    subtotal,
    tax,
    discount,
    roundOff,
    total,
    validUntil,
    notes,
    terms
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Quotation requires at least one item.' });
  }

  if (!store.quotations) store.quotations = [];

  const billing = store.settings.billing || {};
  const year = new Date().getFullYear();
  // A count of the live array would reissue a deleted quotation's number to the next one created (verified live) — a monotonic counter persisted on settings, mirroring invoice numbering, can't go backwards.
  const nextNo = Number(billing.nextQuotationNo) || 1001;
  billing.nextQuotationNo = nextNo + 1;
  const quotationNo = `QT-${year}-${String(nextNo).padStart(4, '0')}`;

  const quotationItems = items.map((i) => ({
    id: i.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    productId: i.productId || i.id,
    name: i.name || 'Item',
    barcode: i.barcode || '',
    hsn: i.hsn || '',
    qty: Number(i.qty) || 1,
    unit: i.unit || 'pcs',
    price: Number(i.price) || 0,
    taxRate: Number(i.taxRate) || 0,
    total: Number(i.total) || Math.round((Number(i.qty) || 1) * (Number(i.price) || 0) * 100) / 100,
    discount: Number(i.discount) || 0
  }));

  const calcSubtotal = r2(subtotal !== undefined ? Number(subtotal) : quotationItems.reduce((s, i) => s + (i.total || (i.qty * i.price)), 0));
  const calcTax = r2(tax !== undefined ? Number(tax) : 0);
  const calcDiscount = r2(discount !== undefined ? Number(discount) : 0);
  const calcRoundOff = r2(roundOff || 0);
  const calcTotal = r2(total !== undefined ? Number(total) : (calcSubtotal + calcTax - calcDiscount + calcRoundOff));

  const validUntilDate = validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const quotation = {
    id: `qt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    quotationNo,
    customerId: customerId || null,
    customerName: customerName || 'Walk-in Customer',
    customerPhone: customerPhone || 'N/A',
    customerGstin: customerGstin || '',
    customerAddress: customerAddress || '',
    date: new Date().toISOString(),
    validUntil: validUntilDate,
    items: quotationItems,
    subtotal: calcSubtotal,
    tax: calcTax,
    discount: calcDiscount,
    roundOff: calcRoundOff,
    total: calcTotal,
    notes: notes || '',
    terms: terms || billing.termsText || 'Prices valid until specified validity date. Subject to stock availability.',
    status: 'PENDING', // PENDING, ACCEPTED, CONVERTED, REJECTED, EXPIRED
    convertedOrderId: null,
    createdBy: actor(req)
  };

  store.quotations.unshift(quotation);

  res.status(201).json({
    success: true,
    message: `Quotation ${quotationNo} created successfully.`,
    data: { ...quotation, company: store.settings.company, billing: store.settings.billing }
  });
});

router.put('/quotations/:id', (req, res) => {
  const store = req.tenantStore;
  const quotation = (store.quotations || []).find((qt) => qt.id === req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });

  // Converted quotation's numbers already carried onto a real posted invoice — editing them after would silently desync the two records, so it's frozen once converted.
  if (quotation.status === 'CONVERTED') {
    return res.status(400).json({
      success: false,
      message: `Quotation ${quotation.quotationNo} is already converted to Invoice #${quotation.convertedOrderId} and can no longer be edited.`
    });
  }

  const {
    customerName, customerPhone, customerGstin, customerAddress,
    items, subtotal, tax, discount, total, validUntil, notes, terms, status
  } = req.body;

  if (customerName !== undefined) quotation.customerName = customerName;
  if (customerPhone !== undefined) quotation.customerPhone = customerPhone;
  if (customerGstin !== undefined) quotation.customerGstin = customerGstin;
  if (customerAddress !== undefined) quotation.customerAddress = customerAddress;
  if (status !== undefined) quotation.status = status;
  if (validUntil !== undefined) quotation.validUntil = validUntil;
  if (notes !== undefined) quotation.notes = notes;
  if (terms !== undefined) quotation.terms = terms;

  if (Array.isArray(items) && items.length > 0) {
    quotation.items = items.map((i) => ({
      id: i.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      productId: i.productId || i.id,
      name: i.name || 'Item',
      barcode: i.barcode || '',
      hsn: i.hsn || '',
      qty: Number(i.qty) || 1,
      unit: i.unit || 'pcs',
      price: Number(i.price) || 0,
      taxRate: Number(i.taxRate) || 0,
      total: Number(i.total) || Math.round((Number(i.qty) || 1) * (Number(i.price) || 0) * 100) / 100,
      discount: Number(i.discount) || 0
    }));
  }

  if (subtotal !== undefined) quotation.subtotal = r2(subtotal);
  if (tax !== undefined) quotation.tax = r2(tax);
  if (discount !== undefined) quotation.discount = r2(discount);
  if (total !== undefined) quotation.total = r2(total);

  quotation.updatedAt = new Date().toISOString();

  res.json({
    success: true,
    message: `Quotation ${quotation.quotationNo} updated.`,
    data: { ...quotation, company: store.settings.company, billing: store.settings.billing }
  });
});

router.delete('/quotations/:id', (req, res) => {
  const store = req.tenantStore;
  const quotation = (store.quotations || []).find((qt) => qt.id === req.params.id || qt.quotationNo === req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });

  // Once converted, the quotation is the audit trail back to the invoice — deleting it would leave the invoice's "Converted from Quotation ..." note pointing at nothing.
  if (quotation.status === 'CONVERTED') {
    return res.status(400).json({
      success: false,
      message: `Quotation ${quotation.quotationNo} is already converted to Invoice #${quotation.convertedOrderId} and can no longer be deleted.`
    });
  }

  store.quotations = (store.quotations || []).filter((qt) => qt.id !== req.params.id && qt.quotationNo !== req.params.id);

  res.json({ success: true, message: 'Quotation deleted.' });
});

/** Convert Quotation into a live Tax Invoice with stock movement & double-entry posting */
router.post('/quotations/:id/convert', async (req, res) => {
  try {
  const store = req.tenantStore;
  const quotation = (store.quotations || []).find((qt) => qt.id === req.params.id || qt.quotationNo === req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });

  if (quotation.status === 'CONVERTED' && quotation.convertedOrderId) {
    return res.status(400).json({
      success: false,
      message: `Quotation ${quotation.quotationNo} is already converted to Invoice #${quotation.convertedOrderId}.`
    });
  }

  const paymentMethod = req.body.paymentMethod || 'Cash';
  const billing = store.settings.billing || {};
  const orderId = `${billing.invoicePrefix || 'INV'}-${new Date().getFullYear()}-${String(billing.nextInvoiceNo || 1).padStart(4, '0')}`;
  billing.nextInvoiceNo = (billing.nextInvoiceNo || 1) + 1;

  let customer = null;
  if (quotation.customerId) customer = store.customers.find((c) => c.id === quotation.customerId);
  if (!customer && quotation.customerName && quotation.customerName !== 'Walk-in Customer') {
    customer = store.customers.find((c) => c.name.toLowerCase() === quotation.customerName.toLowerCase());
  }

  if (negativeStockBlocked(store)) {
    const preCheckShortages = findStockShortages(store, quotation.items);
    if (preCheckShortages.length) {
      return res.status(400).json({
        success: false,
        message: `Not enough stock to convert this quotation to an invoice: ${preCheckShortages.map((s) => `${s.name} (have ${s.available}, need ${s.needed})`).join('; ')}. Turn on "Allow Billing Below Zero Stock" in Settings, or adjust stock first.`,
        shortages: preCheckShortages
      });
    }
  }

  const shortages = deductStock(store, quotation.items, orderId, actor(req));

  const order = {
    orderId,
    customerId: customer ? customer.id : quotation.customerId || null,
    customerName: customer ? customer.name : quotation.customerName || 'Walk-in Customer',
    customerPhone: customer ? customer.phone : quotation.customerPhone || 'N/A',
    customerGstin: quotation.customerGstin || '',
    customerAddress: quotation.customerAddress || '',
    paymentMethod,
    subtotal: quotation.subtotal,
    tax: quotation.tax,
    discount: quotation.discount,
    roundOff: quotation.roundOff || 0,
    loyaltyRedeemed: 0,
    pointsRedeemed: 0,
    grossTotal: quotation.total,
    total: quotation.total,
    notes: `Converted from Quotation ${quotation.quotationNo}${quotation.notes ? ` · ${quotation.notes}` : ''}`,
    tableId: null,
    cashier: actor(req),
    sessionId: store.session?.id || null,
    date: new Date().toISOString(),
    // Conversion always settles in full — the invoice list's paid/due derivation reads paidAmount/balanceDue/paymentStatus, not `status`, so these must be set or every converted invoice shows as UNPAID.
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paidAmount: quotation.total,
    balanceDue: 0,
    paidAt: new Date().toISOString(),
    items: quotation.items
  };

  if (String(paymentMethod).toLowerCase() === 'cash' && store.session) {
    store.session.currentCash = r2(store.session.currentCash + order.total);
    store.session.cashEntries.push({
      type: 'IN',
      amount: order.total,
      reason: `Sale ${orderId} (from Quotation ${quotation.quotationNo})`,
      time: order.date
    });
  }

  try {
    const accounting = posting.postSale(store, order, {
      customer,
      interState: store.settings.tax?.interState,
      createdBy: actor(req)
    });
    order.voucherNo = accounting.voucher.voucherNo;
    order.voucherId = accounting.voucher.id;
    order.cogs = accounting.cogsAmount;
  } catch (err) {
    order.accountingError = err.message;
  }

  if (customer) {
    const account = (store.accounts || []).find((a) => a.partyId === customer.id && a.partyType === 'CUSTOMER');
    if (account) customer.outstanding = Math.max(0, engine.accountBalance(store, account.id));
  }

  store.orders.unshift(order);

  quotation.status = 'CONVERTED';
  quotation.convertedOrderId = orderId;
  quotation.convertedAt = new Date().toISOString();

  res.status(201).json({
    success: true,
    message: `Quotation ${quotation.quotationNo} successfully converted to Invoice ${orderId}.`,
    warnings: shortages.length ? shortages.map((s) => `${s.name}: only ${s.available} left`) : [],
    data: {
      order: { ...order, company: store.settings.company, billing: store.settings.billing },
      quotation
    }
  });
  } catch (err) {
    console.error('[POST /quotations/:id/convert]', err);
    res.status(500).json({ success: false, message: 'Could not convert this quotation. Please try again.' });
  }
});

module.exports = router;
