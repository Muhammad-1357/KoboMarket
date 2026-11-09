import { Schema, model } from "mongoose";

const vendorSchema = new Schema({
  ownerId: { type: String, required: true, unique: true, index: true },
  storeName: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, maxlength: 2000 },
  bankDetails: {
    bankCode: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true }
  },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true }
}, { timestamps: true });

export const Vendor = model("Vendor", vendorSchema);
