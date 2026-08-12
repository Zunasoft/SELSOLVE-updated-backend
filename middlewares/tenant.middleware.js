/**
 * Multi-tenant request middleware.
 *
 * Three jobs, in order:
 *   1. Work out which tenant is calling, from the signed session token only.
 *   2. Load that tenant's working set from its own isolated database.
 *   3. Write the working set back to that same database before responding.
 *
 * The tenant is never taken from a client-supplied header: `x-tenant-db` is
 * accepted only when it agrees with the token, so one shop can never read or
 * write another shop's database by changing a header.
 */

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { newTenantStore } = require('../store');
const { hydrateTenantStore, persistTenantStore } = require('../tenantDb');
const { findTenant, ensureMasterDB } = require('../db');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every refusal from this middleware means the session itself is finished, so
 * each one carries a code the client can recognise. That matters because other
 * middleware also answers 403 for reasons that must NOT sign the user out — a
 * feature missing from the plan, for instance. Status alone is not enough to
 * tell "your session ended" from "your plan does not include this".
 */
const SESSION_ENDED_CODES = [
  'NO_TOKEN',
  'TOKEN_INVALID',
  'TOKEN_UNBOUND',
  'TOKEN_STALE',
  'TENANT_MISMATCH',
  'TENANT_NOT_FOUND',
  'TENANT_INACTIVE'
];

const deny = (res, status, code, message) => res.status(status).json({ success: false, code, message });

const resolveTenantDb = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return deny(res, 401, 'NO_TOKEN', 'Sign in to your shop account to use the POS.');
  }

  let claims;
  try {
    claims = jwt.verify(authHeader.slice(7).trim(), config.JWT_SECRET);
  } catch {
    return deny(res, 401, 'TOKEN_INVALID', 'Your session has expired. Please sign in again.');
  }

  if (!claims.dbName) {
    return deny(res, 401, 'TOKEN_UNBOUND', 'This session is not bound to a shop database. Please sign in again.');
  }

  // A header may accompany the token, but it may not contradict it.
  const headerDb = req.headers['x-tenant-db'];
  if (headerDb && headerDb !== claims.dbName) {
    console.warn(`[Tenant isolation] rejected ${claims.email} requesting "${headerDb}" on a token for "${claims.dbName}".`);
    return deny(res, 403, 'TENANT_MISMATCH', 'This session is not permitted to access that shop database.');
  }

  // The shop is re-read from the master database on every request, in the order
  // the token identifies it. Nothing is answered from process memory, so a
  // deactivation or a plan change takes effect on the very next call.
  if (!(await ensureMasterDB())) {
    return deny(res, 503, 'MASTER_DB_UNAVAILABLE', 'The master database is unreachable. Please try again in a moment.');
  }

  let tenant;
  try {
    tenant =
      (await findTenant({ tenantId: claims.tenantId })) ||
      (await findTenant({ email: claims.email })) ||
      (await findTenant({ dbName: claims.dbName }));
  } catch (err) {
    console.error('[Tenant lookup error]:', err.message);
    return deny(res, 503, 'MASTER_DB_UNAVAILABLE', 'Could not verify your shop account. Please try again in a moment.');
  }

  if (!tenant) {
    return deny(res, 404, 'TENANT_NOT_FOUND', 'This shop account no longer exists. Contact your administrator.');
  }
  if (tenant.status && tenant.status !== 'active') {
    return deny(res, 403, 'TENANT_INACTIVE', 'This shop subscription is currently deactivated. Please contact Super Admin.');
  }
  if (tenant.dbName !== claims.dbName) {
    // The shop was re-provisioned onto a different database since this token was issued.
    return deny(res, 401, 'TOKEN_STALE', 'Your session is out of date. Please sign in again.');
  }

  req.tenant = tenant;
  req.tenantDbName = tenant.dbName;
  req.user = claims;

  try {
    // A fresh working set per request, filled from the tenant's own database.
    // Reusing one across requests would mean a value written by an earlier
    // request on this instance could be read back without touching MongoDB.
    req.tenantStore = await hydrateTenantStore(tenant.dbName, newTenantStore(), tenant);
  } catch (err) {
    console.error(`[Tenant hydrate error ${tenant.dbName}]:`, err.message);
    return deny(res, 503, 'TENANT_DB_UNAVAILABLE', 'Could not reach your shop database. Please try again in a moment.');
  }

  // Persist before the response goes out, so a read that follows a write always
  // sees the write — including when the next request lands on another instance.
  if (MUTATING.has(req.method)) {
    let flush;
    const runFlush = () => persistTenantStore(tenant.dbName, req.tenantStore);
    const flushOnce = () => (flush = flush || runFlush());

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      flushOnce().then((result) => {
        // A write that never reached MongoDB must not be reported as saved —
        // the client would show a record that does not exist anywhere.
        if (result && result.persisted === false) {
          console.error(`[Tenant persist failed ${tenant.dbName}]:`, result.reason);
          if (!res.headersSent) {
            res.status(503);
            return sendJson({
              success: false,
              code: 'TENANT_WRITE_FAILED',
              message: 'Your shop database could not be updated. Please retry — nothing was saved.'
            });
          }
        }
        return sendJson(body);
      });
      return res;
    };

    // Safety net for any handler that answers without res.json().
    res.on('finish', () => {
      flushOnce();
    });
  }

  next();
};

module.exports = { resolveTenantDb, SESSION_ENDED_CODES };
