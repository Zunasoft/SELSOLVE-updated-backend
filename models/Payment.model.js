/**
 * Payment Mongoose Schema — a Razorpay order and its outcome.
 *
 * The order is written the moment checkout opens, so a payment that is never
 * completed still leaves a record to reconcile against.
 */

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    orderId: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    shopName: { type: String },
    planId: { type: String },
    planName: { type: String },
    purpose: { type: String, default: 'RENEWAL' },
    amount: { type: Number, required: true },
    amountInPaise: { type: Number },
    currency: { type: String, default: 'INR' },
    receipt: { type: String },
    status: { type: String, default: 'CREATED' },
    gateway: { type: String, default: 'RAZORPAY_SIMULATION' },
    razorpayPaymentId: { type: String, default: null },
    signature: { type: String, default: null },
    failureReason: { type: String, default: null },
    failureCode: { type: String, default: null },
    createdAt: { type: String, default: () => new Date().toISOString() },
    paidAt: { type: String, default: null },
    failedAt: { type: String, default: null }
  },
  { timestamps: true, strict: false, minimize: false }
);

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
