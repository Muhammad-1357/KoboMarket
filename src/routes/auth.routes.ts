import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate } from "../middleware/auth";
import { AppError } from "../middleware/errors";
import { validateBody } from "../middleware/validate";
import * as auth from "../services/auth.service";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(128)
});
const tokenSchema = z.object({ token: z.string().min(20).max(512) });

authRouter.post("/register", validateBody(credentialsSchema), asyncHandler(async (req, res) => {
  const result = await auth.register(req.body.email, req.body.password);
  res.status(201).json({
    success: true,
    data: {
      userId: result.userId,
      message: "Account created. Verify your email before logging in.",
      ...(process.env.NODE_ENV !== "production" ? { developmentVerificationToken: result.verificationToken } : {})
    }
  });
}));

authRouter.post("/verify-email", validateBody(tokenSchema), asyncHandler(async (req, res) => {
  await auth.verifyEmail(req.body.token);
  res.json({ success: true, data: { message: "Email verified" } });
}));

authRouter.post("/login", validateBody(credentialsSchema), asyncHandler(async (req, res) => {
  const result = await auth.login(req.body.email, req.body.password, req.ip ?? req.socket.remoteAddress ?? "unknown");
  res.json({ success: true, data: result });
}));

authRouter.post("/refresh", validateBody(tokenSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await auth.refresh(req.body.token) });
}));

authRouter.post("/logout", authenticate, asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken as string | undefined;
  await auth.logout(req.user!.id, token);
  res.status(204).end();
}));

authRouter.post("/forgot-password", validateBody(z.object({ email: z.string().email() })), asyncHandler(async (req, res) => {
  const token = await auth.requestPasswordReset(req.body.email);
  res.json({
    success: true,
    data: {
      message: "If the account exists, password reset instructions have been sent.",
      ...(token && process.env.NODE_ENV !== "production" ? { developmentResetToken: token } : {})
    }
  });
}));

authRouter.post("/reset-password", validateBody(z.object({
  token: z.string().min(20).max(512),
  password: z.string().min(10).max(128)
})), asyncHandler(async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.password);
  res.json({ success: true, data: { message: "Password updated" } });
}));

authRouter.get("/me", authenticate, asyncHandler(async (req, res) => {
  const { User } = await import("../models/user.model");
  const user = await User.findById(req.user!.id).select("email roles emailVerifiedAt status").lean();
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  res.json({ success: true, data: user });
}));
