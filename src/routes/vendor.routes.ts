import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateBody } from "../middleware/validate";
import { applyForVendor } from "../services/vendor.service";
import { Vendor } from "../models/vendor.model";
import { AppError } from "../middleware/errors";

export const vendorRouter = Router();

vendorRouter.post("/apply", authenticate, validateBody(z.object({
  storeName: z.string().min(2).max(120),
  description: z.string().min(10).max(2000),
  bankDetails: z.object({
    bankCode: z.string().min(2).max(10),
    accountNumber: z.string().regex(/^\d{10}$/),
    accountName: z.string().min(2).max(120)
  })
})), asyncHandler(async (req, res) => {
  const vendor = await applyForVendor(req.user!.id, req.body);
  res.status(201).json({ success: true, data: { id: vendor.id, status: vendor.status } });
}));

vendorRouter.get("/:id", asyncHandler(async (req, res) => {
  const vendor = await Vendor.findById(requirePathParam(req, "id")).select("-bankDetails -ownerId").lean();
  if (!vendor) throw new AppError(404, "VENDOR_NOT_FOUND", "Vendor not found");
  res.json({ success: true, data: vendor });
}));

vendorRouter.patch("/:id/approve", authenticate, requireRoles("admin"), validateBody(z.object({ approved: z.boolean() })), asyncHandler(async (req, res) => {
  const { approveVendor } = await import("../services/vendor.service");
  await approveVendor(requirePathParam(req, "id"), req.body.approved);
  res.json({ success: true, data: { status: req.body.approved ? "approved" : "rejected" } });
}));
