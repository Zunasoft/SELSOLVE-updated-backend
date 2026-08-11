/**
 * Device Mongoose Schema
 */

const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    deviceName: { type: String, required: true },
    deviceId: { type: String, required: true },
    model: { type: String, default: '' },
    os: { type: String, default: '' },
    ip: { type: String, default: '' },
    status: { type: String, default: 'ACTIVE' },
    registeredAt: { type: String, default: () => new Date().toISOString() },
    lastActiveAt: { type: String, default: () => new Date().toISOString() }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema);
