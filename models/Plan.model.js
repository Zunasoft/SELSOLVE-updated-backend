/**
 * Plan Mongoose Schema
 */

const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    billingCycle: { type: String, default: 'Monthly' },
    maxDevices: { type: Number, default: 2 },
    features: [{ type: String }],
    // Which licence model the tier sells: a seat per device, or one per shop.
    licenseModel: { type: String, default: 'PER_DEVICE' },
    trialDays: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // Marks a feature list as written against the current catalogue, so the
    // legacy widening in db.js runs exactly once per plan.
    featureSchema: { type: Number, default: 1 }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Plan || mongoose.model('Plan', planSchema);
