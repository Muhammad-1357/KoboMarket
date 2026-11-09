import { Schema, model } from "mongoose";

const notificationSchema = new Schema({
  userId: { type: String, required: true, index: true },
  sourceEventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
  readAt: { type: Date }
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
export const Notification = model("Notification", notificationSchema);
