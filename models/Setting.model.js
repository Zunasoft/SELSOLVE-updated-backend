/**
 * Master Setting Mongoose Schema
 */

const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'master_settings' },
    maintenanceMode: { type: Boolean, default: false },
    systemNotification: { type: String, default: 'Welcome to Zunasoft Smart POS Master Backend!' },
    otpExpiryMinutes: { type: Number, default: 10 },
    allowRegistration: { type: Boolean, default: true },
    platformVersion: { type: String, default: 'v2.5 Enterprise Unified Master' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Setting || mongoose.model('Setting', settingSchema);
