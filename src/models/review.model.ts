import { Schema, model } from "mongoose";

const reviewSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  buyerId: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, maxlength: 2000 }
}, { timestamps: true });

reviewSchema.index({ productId: 1, buyerId: 1 }, { unique: true });
export const Review = model("Review", reviewSchema);
