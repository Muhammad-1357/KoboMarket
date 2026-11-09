import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateBody, validateQuery } from "../middleware/validate";
import { AppError } from "../middleware/errors";
import { approveVendor } from "../services/vendor.service";
import {
  escrowBalance, freezeUser, listVendors, reconciliation, revenueByDay, searchUsers,
  topVendors, updateCommission, walletLedgerById, walletTransactions
} from "../services/admin.service";
import { sql } from "../db/postgres";

export const adminRouter = Router();
adminRouter.use(authenticate, requireRoles("admin"));

adminRouter.get("/users", validateQuery(z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as { q?: string; limit: number };
  res.json({ success: true, data: await searchUsers(query.q, query.limit) });
}));

adminRouter.patch("/users/:id/freeze", validateBody(z.object({ frozen: z.boolean() })), asyncHandler(async (req, res) => {
  await freezeUser(requirePathParam(req, "id"), req.body.frozen);
  res.json({ success: true, data: { frozen: req.body.frozen } });
}));

adminRouter.get("/vendors", validateQuery(z.object({ q: z.string().max(200).optional() })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listVendors(req.query.q as string | undefined) });
}));

adminRouter.patch("/vendors/:id/approve", validateBody(z.object({ approved: z.boolean() })), asyncHandler(async (req, res) => {
  await approveVendor(requirePathParam(req, "id"), req.body.approved);
  res.json({ success: true, data: { status: req.body.approved ? "approved" : "rejected" } });
}));

adminRouter.get("/wallets/:id/ledger", asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "INVALID_LIMIT", "limit must be between 1 and 100");
  res.json({ success: true, data: await walletLedgerById(requirePathParam(req, "id"), req.query.cursor as string | undefined, limit) });
}));

adminRouter.get("/transactions", validateQuery(z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional()
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as { limit: number; cursor?: string };
  let rows = sql("transactions").select("id", "reference", "type", "status", "metadata", "created_at")
    .orderBy("created_at", "desc").limit(query.limit);
  if (query.cursor) rows = rows.where("id", "<", query.cursor);
  res.json({ success: true, data: await rows });
}));

adminRouter.patch("/settings/commission", validateBody(z.object({ commissionBps: z.number().int().min(0).max(10000) })), asyncHandler(async (req, res) => {
  await updateCommission(req.body.commissionBps);
  res.json({ success: true, data: { commissionBps: req.body.commissionBps } });
}));

adminRouter.get("/reports/revenue", validateQuery(z.object({
  from: z.string().date(),
  to: z.string().date()
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as { from: string; to: string };
  if (query.from > query.to) throw new AppError(400, "INVALID_DATE_RANGE", "from must be on or before to");
  res.json({ success: true, data: await revenueByDay(query.from, query.to) });
}));

adminRouter.get("/reports/top-vendors", asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await topVendors() });
}));

adminRouter.get("/reports/escrow", asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { balanceKobo: await escrowBalance() } });
}));

adminRouter.get("/reports/reconciliation", asyncHandler(async (_req, res) => {
  const mismatches = await reconciliation();
  res.json({ success: true, data: { reconciled: mismatches.length === 0, mismatches } });
}));
