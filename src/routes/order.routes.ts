import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { AppError } from "../middleware/errors";
import { requirePathParam, validateBody } from "../middleware/validate";
import { cancelOrder, checkout, confirmDelivery, getOrder, listOrders, shipSubOrder } from "../services/order.service";

export const orderRouter = Router();

orderRouter.post("/orders/checkout", authenticate, requireRoles("buyer"), asyncHandler(async (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 200) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  const result = await checkout(req.user!.id, key);
  res.status(201).json({ success: true, data: result });
}));

orderRouter.get("/orders", authenticate, asyncHandler(async (req, res) => {
  const user = req.user!;
  const role = user.roles.includes("admin") ? "buyer" : user.roles.includes("vendor") ? "vendor" : "buyer";
  res.json({ success: true, data: await listOrders(user.id, role) });
}));

orderRouter.get("/orders/:id", authenticate, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getOrder(req.user!.id, requirePathParam(req, "id"), req.user!.roles) });
}));

orderRouter.post("/orders/:id/cancel", authenticate, requireRoles("buyer"), asyncHandler(async (req, res) => {
  await cancelOrder(req.user!.id, requirePathParam(req, "id"));
  res.json({ success: true, data: { status: "CANCELLED" } });
}));

orderRouter.patch("/sub-orders/:id/ship", authenticate, requireRoles("vendor"), validateBody(z.object({}).strict()), asyncHandler(async (req, res) => {
  await shipSubOrder(req.user!.id, requirePathParam(req, "id"));
  res.json({ success: true, data: { status: "SHIPPED" } });
}));

orderRouter.patch("/sub-orders/:id/confirm", authenticate, requireRoles("buyer"), asyncHandler(async (req, res) => {
  await confirmDelivery(req.user!.id, requirePathParam(req, "id"));
  res.json({ success: true, data: { status: "COMPLETED" } });
}));
