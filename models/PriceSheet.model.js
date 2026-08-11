/**
 * Price Sheet Mongoose Schema
 */

const mongoose = require('mongoose');

const priceSheetSchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    name: { type: String, required: true },
    code: { type: String, required: true },
    customerType: { type: String, default: 'Retail' },
    isActive: { type: Boolean, default: true },
    pricingMap: { type: Map, of: Number, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.models.PriceSheet || mongoose.model('PriceSheet', priceSheetSchema);
