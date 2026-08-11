/**
 * Payment Mongoose Schema
 */

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    planId: { type: String },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, default: 'COMPLETED' },
    gateway: { type: String, default: 'SIMULATED' },
    transactionId: { type: String },
    purpose: { type: String, default: 'NEW_SUBSCRIPTION' },
    createdAt: { type: String, default: () => new Date().toISOString() }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
