
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    name: { type: String, required: true, trim: true },
    printName: { type: String, default: '' },
    regionalName: { type: String, default: '' },
    description: { type: String, default: '' },
    categoryId: { type: String, default: 'cat_1' },
    categoryIds: { type: [String], default: undefined },
    productType: {
      type: String,
      enum: ['standard', 'raw', 'service', 'combo', 'composite'],
      default: 'standard'
    },
    productTypes: { type: [String], default: undefined },
    barcode: {
      type: String,
      default: () => Math.floor(1000000000 + Math.random() * 9000000000).toString(),
      index: true
    },
    barcodes: [{ type: String }],
    defaultBarcode: { type: String },
    hsn: { type: String, default: '' },
    unit: { type: String, default: 'pcs' },
    price: { type: Number, required: true, default: 0 },
    mrp: { type: Number, default: 0 },
    purchasePrice: { type: Number, default: 0 },
    wholesalePrice: { type: Number, default: 0 },
    specialPrice: { type: Number, default: 0 },
    pricingHistory: [
      {
        date: String,
        oldPrice: Number,
        newPrice: Number,
        oldPurchasePrice: Number,
        newPurchasePrice: Number,
        updatedBy: String
      }
    ],
    isComposite: { type: Boolean, default: false },
    comboItems: [{ productId: String, qty: Number }],
    recipeItems: [{ productId: String, name: String, qty: Number, unit: String, cost: Number }],
    recipeYieldQty: { type: Number, default: 1 },
    recipeNotes: { type: String, default: '' },
    useCustomPricing: { type: Boolean, default: false },
    warehouses: { type: Map, of: Number },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, strict: false }
);

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
