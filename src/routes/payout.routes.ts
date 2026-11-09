import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { validateBody } from "../middleware/validate";
import { AppError } from "../middleware/errors";
import { listPayouts, requestPayout } from "../services/payout.service";

export const payoutRouter = Router();
payoutRouter.use(authenticate, requireRoles("vendor"));

payoutRouter.post("/", validateBody(z.object({ amountKobo: z.number().int().positive().safe() })), asyncHandler(async (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 200) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  res.status(201).json({ success: true, data: await requestPayout(req.user!.id, req.body.amountKobo, key) });
}));

payoutRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listPayouts(req.user!.id) });
}));
