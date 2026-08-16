const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    type: {
      type: String,
      enum: ['SALE', 'PURCHASE', 'ADJUSTMENT', 'TRANSFER', 'OPENING', 'RETURN', 'RECIPE'],
      required: true
    },
    qtyChange: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    unit: { type: String, default: 'pcs' },
    reason: { type: String, default: '' },
    refId: { type: String, default: null },
    user: { type: String, default: 'system' },
    date: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
