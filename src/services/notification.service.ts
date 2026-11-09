import mongoose from "mongoose";
import { AppError } from "../middleware/errors";
import { Notification } from "../models/notification.model";

type NotificationCursor = { createdAt: string; id: string };

function decodeCursor(cursor: string): NotificationCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as NotificationCursor;
    if (!mongoose.isValidObjectId(parsed.id) || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("Invalid cursor");
    return parsed;
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Notification cursor is invalid");
  }
}

export async function listNotifications(userId: string, limit: number, cursor?: string) {
  const filter: Record<string, unknown> = { userId };
  if (cursor) {
    const value = decodeCursor(cursor);
    filter.$or = [
      { createdAt: { $lt: new Date(value.createdAt) } },
      { createdAt: new Date(value.createdAt), _id: { $lt: new mongoose.Types.ObjectId(value.id) } }
    ];
  }
  const rows = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, -1) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last._id.toString() })).toString("base64url")
      : null
  };
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
  const result = await Notification.updateOne({ _id: id, userId }, { $set: { readAt: new Date() } });
  if (result.matchedCount !== 1) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await Notification.updateMany({ userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  return Notification.countDocuments({ userId, readAt: { $exists: false } });
}
