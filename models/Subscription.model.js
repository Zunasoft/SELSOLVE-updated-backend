/**
 * Subscription Mongoose Schema — one row per billing event.
 *
 * This is the subscription *history* ledger: a renewal, a trial grant or a
 * captured payment each append a row. The shop's current plan and expiry live
 * on the tenant record itself; these rows are how that state was arrived at.
 */

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true, index: true },
    shopName: { type: String },
    action: { type: String, default: 'RENEWAL' },
    plan: { type: String },
    planName: { type: String },
    amount: { type: Number, default: 0 },
    days: { type: Number, default: 0 },
    previousExpiry: { type: String },
    newExpiry: { type: String },
    paymentId: { type: String, default: null },
    notes: { type: String, default: '' },
    performedBy: { type: String },
    createdAt: { type: String, default: () => new Date().toISOString() }
  },
  { timestamps: true, strict: false, minimize: false }
);

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
