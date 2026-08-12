/**
 * Device Mongoose Schema — a POS terminal licensed to a shop.
 *
 * Field names mirror exactly what `modules/licensing.js` writes; `strict: false`
 * keeps any additional field the licence flow attaches rather than dropping it
 * silently on save.
 */

const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    deviceName: { type: String, required: true },
    model: { type: String, default: 'Android POS Terminal' },
    androidVersion: { type: String, default: '—' },
    appVersion: { type: String, default: '—' },
    licenseKey: { type: String },
    licenseModel: { type: String, default: 'PER_DEVICE' },
    status: { type: String, default: 'active' },
    registeredAt: { type: String, default: () => new Date().toISOString() },
    lastSeenAt: { type: String, default: () => new Date().toISOString() }
  },
  { timestamps: true, strict: false, minimize: false }
);

// A hardware id may be registered once per shop.
deviceSchema.index({ tenantId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema);
