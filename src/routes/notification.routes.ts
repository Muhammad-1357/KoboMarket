import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateQuery } from "../middleware/validate";
import { listNotifications, markAllNotificationsRead, markNotificationRead, unreadNotificationCount } from "../services/notification.service";

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get("/", validateQuery(z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as { cursor?: string; limit: number };
  res.json({ success: true, data: await listNotifications(req.user!.id, query.limit, query.cursor) });
}));

notificationRouter.get("/unread-count", asyncHandler(async (req, res) => {
  res.json({ success: true, data: { count: await unreadNotificationCount(req.user!.id) } });
}));

notificationRouter.patch("/read-all", asyncHandler(async (req, res) => {
  res.json({ success: true, data: { updated: await markAllNotificationsRead(req.user!.id) } });
}));

notificationRouter.patch("/:id/read", asyncHandler(async (req, res) => {
  await markNotificationRead(req.user!.id, requirePathParam(req, "id"));
  res.json({ success: true, data: { read: true } });
}));
