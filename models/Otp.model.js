/**
 * One-time login code — Mongoose Schema.
 *
 * Login codes live in the master database, never in process memory. On a
 * serverless host the request that asks for a code and the request that
 * verifies it routinely land on two different instances, so an in-memory code
 * would verify as "expired" perhaps half the time.
 *
 * Only the SHA-256 hash of the code is stored, and a TTL index lets MongoDB
 * clear expired rows on its own. `scope` separates a Super Admin console code
 * from a shop owner's POS code, so the same address can hold one of each.
 */

const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    scope: { type: String, required: true, enum: ['admin', 'tenant'] },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    issuedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

// One live code per address per scope — requesting a new one replaces the old.
otpSchema.index({ email: 1, scope: 1 }, { unique: true });

// MongoDB removes a row once `expiresAt` passes. The handlers still compare the
// timestamp themselves, because the TTL monitor only sweeps once a minute.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Otp || mongoose.model('Otp', otpSchema);
