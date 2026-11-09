import { Schema, model } from "mongoose";

const loginAttemptSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  windowStartedAt: { type: Date, required: true }
});

loginAttemptSchema.index({ windowStartedAt: 1 }, { expireAfterSeconds: 900 });
export const LoginAttempt = model("LoginAttempt", loginAttemptSchema);
