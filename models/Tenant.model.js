/**
 * Tenant Mongoose Schema
 */

const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String },
    dbName: { type: String, required: true },
    status: { type: String, default: 'active' },
    plan: { type: String, default: 'starter' },
    expiryDate: { type: String },
    maxDevices: { type: Number, default: 2 },
    features: {
      billing: { type: Boolean, default: true },
      inventory: { type: Boolean, default: true },
      purchases: { type: Boolean, default: false },
      reports: { type: Boolean, default: true },
      compositeItems: { type: Boolean, default: false },
      tableMgmt: { type: Boolean, default: false }
    },
    createdAt: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
