import { Schema, model } from "mongoose";

const variantSchema = new Schema({
  sku: { type: String, required: true },
  attributes: { type: Map, of: String, default: {} },
  priceKobo: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, min: 0 }
}, { _id: false });

const productSchema = new Schema({
  vendorId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, required: true, maxlength: 10000 },
  priceKobo: { type: Number, required: true, min: 0 },
  category: { type: String, required: true, index: true },
  images: { type: [String], default: [] },
  stock: { type: Number, required: true, min: 0 },
  variants: { type: [variantSchema], default: [] },
  tags: { type: [String], default: [] },
  isActive: { type: Boolean, default: true, index: true },
  deletedAt: { type: Date },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0, min: 0 },
  inventoryAdjustmentIds: { type: [String], default: [] }
}, { timestamps: true });

productSchema.index({ name: "text", description: "text" });
productSchema.index({ isActive: 1, createdAt: -1, _id: -1 });
productSchema.index({ category: 1, priceKobo: 1 });
export const Product = model("Product", productSchema);
