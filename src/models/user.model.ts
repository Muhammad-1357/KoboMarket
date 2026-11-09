import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  roles: { type: [String], enum: ["buyer", "vendor", "admin"], default: ["buyer"] },
  firstName: { type: String, maxlength: 80 },
  lastName: { type: String, maxlength: 80 },
  phone: { type: String, maxlength: 30 },
  emailVerifiedAt: { type: Date },
  verificationTokenHash: { type: String },
  verificationExpiresAt: { type: Date },
  resetTokenHash: { type: String },
  resetExpiresAt: { type: Date },
  refreshTokens: [{
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date }
  }],
  status: { type: String, enum: ["provisioning", "active", "frozen"], default: "provisioning" }
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });
export type UserDocument = InferSchemaType<typeof userSchema>;
export const User = model("User", userSchema);
