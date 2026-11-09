import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { requirePathParam, validateBody, validateQuery } from "../middleware/validate";
import { addReview, createProduct, getProduct, listProducts, softDeleteProduct, updateProduct } from "../services/product.service";

export const productRouter = Router();

const productInput = z.object({
  name: z.string().min(2).max(160),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  description: z.string().min(1).max(10000),
  priceKobo: z.number().int().nonnegative().safe(),
  category: z.string().min(1).max(80),
  images: z.array(z.string().url()).max(12).default([]),
  stock: z.number().int().nonnegative().max(1000000),
  variants: z.array(z.object({
    sku: z.string().min(1).max(80),
    attributes: z.record(z.string()),
    priceKobo: z.number().int().nonnegative().safe(),
    stock: z.number().int().nonnegative().max(1000000)
  })).max(100).default([]),
  tags: z.array(z.string().max(40)).max(30).default([])
});

productRouter.get("/", validateQuery(z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  vendorId: z.string().max(100).optional(),
  sort: z.enum(["price", "newest", "rating"]).default("newest"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})), asyncHandler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof listProducts>[0];
  res.json({ success: true, data: await listProducts(query) });
}));

productRouter.get("/:slug", asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getProduct(requirePathParam(req, "slug")) });
}));

productRouter.post("/", authenticate, requireRoles("vendor"), validateBody(productInput), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await createProduct(req.user!.id, req.body) });
}));

productRouter.patch("/:id", authenticate, requireRoles("vendor"), validateBody(productInput.partial()), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await updateProduct(req.user!.id, requirePathParam(req, "id"), req.body) });
}));

productRouter.delete("/:id", authenticate, requireRoles("vendor"), asyncHandler(async (req, res) => {
  await softDeleteProduct(req.user!.id, requirePathParam(req, "id"));
  res.status(204).end();
}));

productRouter.post("/:id/reviews", authenticate, requireRoles("buyer"), validateBody(z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional()
})), asyncHandler(async (req, res) => {
  const result = await addReview(req.user!.id, requirePathParam(req, "id"), req.body.rating, req.body.comment);
  res.status(201).json({ success: true, data: result });
}));
