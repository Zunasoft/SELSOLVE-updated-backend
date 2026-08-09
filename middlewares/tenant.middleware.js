/**
 * Multi-Tenant Middleware
 * Resolves request to the provisioned tenant store using JWT or x-tenant-db header.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { getTenantStore } = require('../store');

const resolveTenantDb = (req, res, next) => {
  let tenantDbName = req.headers['x-tenant-db'];

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], config.JWT_SECRET);
      if (decoded.dbName) tenantDbName = decoded.dbName;
      req.user = decoded;
    } catch (e) {
      /* fall through to header tenant */
    }
  }

  req.tenantDbName = tenantDbName || 'tenant_db_freshmart';
  req.tenantStore = getTenantStore(req.tenantDbName);
  next();
};

module.exports = { resolveTenantDb };
