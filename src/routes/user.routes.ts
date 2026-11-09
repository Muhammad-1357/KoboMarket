import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { validateBody } from "../middleware/validate";
import { AppError } from "../middleware/errors";
import { User } from "../models/user.model";

export const userRouter = Router();

userRouter.get("/me", authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!.id).select("-passwordHash -refreshTokens -verificationTokenHash -resetTokenHash").lean();
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  res.json({ success: true, data: user });
}));

userRouter.patch("/me", authenticate, validateBody(z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  phone: z.string().max(30).optional()
}).strict()), asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user!.id, { $set: req.body }, {
    new: true,
    runValidators: true
  }).select("-passwordHash -refreshTokens -verificationTokenHash -resetTokenHash").lean();
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  res.json({ success: true, data: user });
}));
