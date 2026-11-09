import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { errorHandler, notFound } from "./middleware/errors";
import { authRouter } from "./routes/auth.routes";
import { healthRouter } from "./routes/health.routes";
import { logger } from "./logger";
import { walletRouter, webhookRouter } from "./routes/wallet.routes";
import { vendorRouter } from "./routes/vendor.routes";
import { productRouter } from "./routes/product.routes";
import { cartRouter } from "./routes/cart.routes";
import { orderRouter } from "./routes/order.routes";
import { payoutRouter } from "./routes/payout.routes";
import { disputeRouter } from "./routes/dispute.routes";
import { notificationRouter } from "./routes/notification.routes";
import { adminRouter } from "./routes/admin.routes";
import { userRouter } from "./routes/user.routes";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./docs/openapi";

export const app = express();

app.disable("x-powered-by");
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => {
    const suppliedId = req.headers["x-request-id"];
    const id = typeof suppliedId === "string" && suppliedId.length <= 128 ? suppliedId : crypto.randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  }
}));
app.use(helmet());
app.use(cors({ origin: config.frontendOrigin, credentials: true }));
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.use("/api/v1/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true }));
app.use("/api/v1", healthRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/wallet", walletRouter);
app.use("/api/v1/webhooks", webhookRouter);
app.use("/api/v1/vendors", vendorRouter);
app.use("/api/v1/products", productRouter);
app.use("/api/v1/cart", cartRouter);
app.use("/api/v1", orderRouter);
app.use("/api/v1", disputeRouter);
app.use("/api/v1/payouts", payoutRouter);
app.use("/api/v1/notifications", notificationRouter);
app.use("/api/v1/admin", adminRouter);
app.use(notFound);
app.use(errorHandler);
