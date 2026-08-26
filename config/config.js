require('dotenv').config();

const crypto = require('crypto');

/**
 * Every tenant token, every super-admin session, and the tenant-isolation
 * check in tenant.middleware.js all trust this secret. It used to fall back
 * to a literal string committed in this file, so any deployment that forgot
 * to set JWT_SECRET was silently signing (and verifying) tokens with a secret
 * anyone could read straight out of the repo — forgeable tenant/admin tokens,
 * bypassing tenant isolation entirely. Production now fails to boot instead;
 * local dev gets a random secret generated once per process so there's never
 * a real, known secret sitting in source.
 */
const resolveJwtSecret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in the environment for a production deployment.');
  }
  console.warn('[config] JWT_SECRET not set — generating a random secret for this process (dev only).');
  return crypto.randomBytes(32).toString('hex');
};

const defaultAllowedOrigins = [
  'https://selsolve-admin.zunasoft.com',
  'http://localhost:5173',
  'https://selsolve-pos.zunasoft.com',
  'http://localhost:5175'
];

const envOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = Array.from(
  new Set([...defaultAllowedOrigins, ...envOrigins].map((o) => o.replace(/\/$/, '')))
);

module.exports = {
  PORT: process.env.PORT || 5001,
  MONGODB_URI: process.env.ADMIN_BE_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017/selsolve',
  JWT_SECRET: resolveJwtSecret(),
  ALLOWED_ORIGINS: allowedOrigins
};
