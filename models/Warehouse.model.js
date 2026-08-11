/**
 * Warehouse Mongoose Schema
 */

const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true },
    location: { type: String, default: '' },
    isDefault: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Warehouse || mongoose.model('Warehouse', warehouseSchema);
