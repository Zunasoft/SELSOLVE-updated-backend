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

    /**
     * The shop's feature map, `{ featureKey: boolean }`.
     *
     * Deliberately Mixed rather than a fixed key list. This was previously
     * declared with the six feature names that existed at the time, which meant
     * Mongoose silently dropped every newer key on save — a shop could be moved
     * to Enterprise and still come back with only the old six, because the other
     * fifteen never reached the database. The catalogue in `modules/features.js`
     * is the single source of truth for which keys are valid.
     */
    features: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdAt: { type: String }
  },
  // Non-strict so a field added to the tenant record is stored rather than
  // quietly discarded, which is how the features truncation went unnoticed.
  { timestamps: true, strict: false, minimize: false }
);

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
