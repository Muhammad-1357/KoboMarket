import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateBody } from "../middleware/validate";
import { listDisputes, openDispute, resolveDispute } from "../services/dispute.service";

export const disputeRouter = Router();

disputeRouter.post("/sub-orders/:id/disputes", authenticate, requireRoles("buyer"), validateBody(z.object({
  reason: z.string().min(5).max(4000),
  evidence: z.array(z.string().url()).max(20).default([])
})), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await openDispute(req.user!.id, requirePathParam(req, "id"), req.body.reason, req.body.evidence) });
}));

disputeRouter.get("/disputes", authenticate, requireRoles("admin"), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await listDisputes() });
}));

disputeRouter.patch("/disputes/:id/resolve", authenticate, requireRoles("admin"), validateBody(z.object({
  resolution: z.enum(["full_refund", "partial_refund", "reject"]),
  note: z.string().min(3).max(2000),
  refundAmountKobo: z.number().int().positive().safe().optional()
}).superRefine((value, context) => {
  if (value.resolution === "partial_refund" && value.refundAmountKobo === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refundAmountKobo"], message: "Partial refund amount is required" });
  }
  if (value.resolution !== "partial_refund" && value.refundAmountKobo !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refundAmountKobo"], message: "Refund amount is only valid for partial refunds" });
  }
})), asyncHandler(async (req, res) => {
  await resolveDispute(requirePathParam(req, "id"), req.user!.id, req.body.resolution, req.body.note, req.body.refundAmountKobo);
  res.json({ success: true, data: { status: "RESOLVED" } });
}));
