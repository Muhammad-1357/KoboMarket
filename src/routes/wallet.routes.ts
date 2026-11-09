import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { validateBody, validateQuery } from "../middleware/validate";
import { processFundingWebhook, initializeFunding, getWallet, listLedger } from "../services/wallet.service";
import { AppError } from "../middleware/errors";

export const walletRouter = Router();

walletRouter.get("/", authenticate, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getWallet(req.user!.id) });
}));

walletRouter.get("/transactions", authenticate, validateQuery(z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as { cursor?: string; limit: number };
  res.json({ success: true, data: await listLedger(req.user!.id, query.cursor, query.limit) });
}));

walletRouter.post("/fund", authenticate, validateBody(z.object({ amountKobo: z.number().int().positive() })), asyncHandler(async (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 200) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  const result = await initializeFunding(req.user!.id, req.body.amountKobo, key);
  res.status(201).json({ success: true, data: result });
}));

const paystackWebhookHandler = asyncHandler(async (req, res) => {
  const result = await processFundingWebhook(req.rawBody ?? Buffer.alloc(0), req.header("x-paystack-signature"), req.body);
  res.json({ success: true, data: result });
});

walletRouter.post("/webhooks/paystack", paystackWebhookHandler);

export const webhookRouter = Router();
webhookRouter.post("/paystack", paystackWebhookHandler);
