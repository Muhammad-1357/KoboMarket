import type { Request, RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "./errors";

export function requirePathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new AppError(400, "INVALID_PATH_PARAMETER", `${name} is required`);
  return value;
}

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(result.error);
      return;
    }
    Object.assign(req.query, result.data);
    next();
  };
}
