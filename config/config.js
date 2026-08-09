/**
 * Application Configuration
 * Centralized environment configuration for Selsolve POS Backend.
 */

require('dotenv').config();

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
  JWT_SECRET: process.env.JWT_SECRET || 'super_secret_jwt_key_zunasoft_2026',
  ALLOWED_ORIGINS: allowedOrigins
};
