import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.flatten() }
    });
    return;
  }
  const appError = error instanceof AppError
    ? error
    : new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
  req.log?.error({ err: error, requestId: req.id }, "Request failed");
  res.status(appError.status).json({
    success: false,
    error: { code: appError.code, message: appError.message, details: appError.details }
  });
};
