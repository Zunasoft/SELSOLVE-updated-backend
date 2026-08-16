const express = require('express');
const router = express.Router();
const warehouse = require('../controllers/warehouse.controller');

router.get('/warehouses', warehouse.getWarehouses);
router.post('/warehouses', warehouse.createWarehouse);
router.put('/warehouses/:id', warehouse.updateWarehouse);
router.delete('/warehouses/:id', warehouse.deleteWarehouse);

router.post('/inventory/transfer', warehouse.transferStock);

module.exports = router;
