import { Schema, model } from "mongoose";

const cartItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  variantSku: { type: String },
  quantity: { type: Number, required: true, min: 1, max: 10000 },
  priceAtAddKobo: { type: Number, required: true, min: 0 }
}, { timestamps: true });

const cartSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  items: { type: [cartItemSchema], default: [] }
}, { timestamps: true });

export const Cart = model("Cart", cartSchema);
