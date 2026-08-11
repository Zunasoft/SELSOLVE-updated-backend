/**
 * Subscription Mongoose Schema
 */

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    planId: { type: String, required: true },
    status: { type: String, default: 'ACTIVE' },
    startDate: { type: String },
    expiryDate: { type: String },
    autoRenew: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
