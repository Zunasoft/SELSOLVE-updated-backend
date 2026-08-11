/**
 * Category Mongoose Schema
 */

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    name: { type: String, required: true, trim: true },
    icon: { type: String, default: '📦' },
    description: { type: String, default: '' },
    kotPrinter: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Category || mongoose.model('Category', categorySchema);
