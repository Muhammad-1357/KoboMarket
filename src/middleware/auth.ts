import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { AppError } from "./errors";
import { User } from "../models/user.model";

export const authenticate: RequestHandler = (req, _res, next) => {
  const token = req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    next(new AppError(401, "UNAUTHENTICATED", "Authentication is required"));
    return;
  }
  try {
    const payload = jwt.verify(token, config.accessSecret);
    if (typeof payload === "string" || !payload.sub || !Array.isArray(payload.roles)) {
      throw new Error("Invalid token claims");
    }
    void User.findById(payload.sub).select("roles status").lean().then((user) => {
      if (!user || user.status !== "active") {
        next(new AppError(401, "INVALID_SESSION", "User session is no longer active"));
        return;
      }
      req.user = { id: user._id.toString(), roles: user.roles };
      next();
    }).catch(next);
  } catch {
    next(new AppError(401, "INVALID_TOKEN", "Access token is invalid or expired"));
  }
};

export function requireRoles(...roles: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.some((role) => req.user?.roles.includes(role))) {
      next(new AppError(403, "FORBIDDEN", "You do not have permission to perform this action"));
      return;
    }
    next();
  };
}
