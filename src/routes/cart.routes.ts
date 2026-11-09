import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateBody } from "../middleware/validate";
import { addItem, getCart, removeItem, updateItem } from "../services/cart.service";

export const cartRouter = Router();
cartRouter.use(authenticate);

cartRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getCart(req.user!.id) });
}));

cartRouter.post("/items", validateBody(z.object({
  productId: z.string().regex(/^[0-9a-f]{24}$/i),
  variantSku: z.string().max(80).optional(),
  quantity: z.number().int().positive().max(10000)
})), asyncHandler(async (req, res) => {
  const cart = await addItem(req.user!.id, req.body.productId, req.body.quantity, req.body.variantSku);
  res.status(201).json({ success: true, data: cart });
}));

cartRouter.patch("/items/:itemId", validateBody(z.object({ quantity: z.number().int().positive().max(10000) })), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await updateItem(req.user!.id, requirePathParam(req, "itemId"), req.body.quantity) });
}));

cartRouter.delete("/items/:itemId", asyncHandler(async (req, res) => {
  await removeItem(req.user!.id, requirePathParam(req, "itemId"));
  res.status(204).end();
}));
