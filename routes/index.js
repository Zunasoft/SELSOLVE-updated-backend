/**
 * Centralized API Router Index
 * Combines all modular routes under /api/pos
 */

const express = require('express');
const router = express.Router();

router.use(require('./sales'));
router.use(require('./catalog.routes'));
router.use(require('./upload.routes'));
router.use(require('./warehouse.routes'));
router.use(require('./parties'));
router.use(require('./config'));
router.use(require('./reports'));
router.use('/accounts', require('../accounting/routes'));

module.exports = router;
