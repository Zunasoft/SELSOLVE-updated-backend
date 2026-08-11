/**
 * Super Admin Mongoose Schema
 */

const mongoose = require('mongoose');

const superAdminSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, default: 'SuperAdmin' },
    status: { type: String, default: 'active' },
    lastLoginAt: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.SuperAdmin || mongoose.model('SuperAdmin', superAdminSchema);
