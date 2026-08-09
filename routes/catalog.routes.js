/**
 * Catalog Router Definitions
 */

const express = require('express');
const router = express.Router();
const catalog = require('../controllers/catalog.controller');

// Units
router.get('/units', catalog.getUnits);
router.post('/units', catalog.createUnit);
router.put('/units/:oldName', catalog.updateUnit);
router.delete('/units/:name', catalog.deleteUnit);

// Categories
router.get('/categories', catalog.getCategories);
router.post('/categories', catalog.createCategory);
router.put('/categories/:id', catalog.updateCategory);
router.delete('/categories/:id', catalog.deleteCategory);

// Products
router.get('/products', catalog.getProducts);
router.get('/products/lookup/:barcode', catalog.lookupProduct);
router.post('/products', catalog.createProduct);
router.put('/products/:id', catalog.updateProduct);
router.delete('/products/:id', catalog.deleteProduct);

// Price Sheets
router.get('/price-sheets', catalog.getPriceSheets);
router.post('/price-sheets', catalog.createPriceSheet);
router.put('/price-sheets/:id', catalog.updatePriceSheet);
router.delete('/price-sheets/:id', catalog.deletePriceSheet);

router.get('/products/pricesheet', catalog.getPriceSheetGrid);
router.put('/products/pricesheet', catalog.updatePriceSheetGrid);

// Bulk Import
router.post('/products/bulk-import', catalog.bulkImportProducts);

// Stock Management
router.get('/inventory/summary', catalog.getInventorySummary);
router.post('/inventory/adjust', catalog.adjustStock);
router.get('/inventory/movements', catalog.getStockMovements);

module.exports = router;
