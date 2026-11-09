import mongoose from "mongoose";
import { sql } from "../db/postgres";
import { AppError } from "../middleware/errors";
import { Product } from "../models/product.model";
import { Review } from "../models/review.model";
import { Vendor } from "../models/vendor.model";

export type ProductInput = {
  name: string;
  slug: string;
  description: string;
  priceKobo: number;
  category: string;
  images: string[];
  stock: number;
  variants: Array<{ sku: string; attributes: Record<string, string>; priceKobo: number; stock: number }>;
  tags: string[];
};

async function approvedVendor(ownerId: string) {
  const vendor = await Vendor.findOne({ ownerId, status: "approved" });
  if (!vendor) throw new AppError(403, "VENDOR_NOT_APPROVED", "An approved vendor store is required");
  return vendor;
}

export async function createProduct(ownerId: string, input: ProductInput) {
  const vendor = await approvedVendor(ownerId);
  try {
    return await Product.create({ ...input, vendorId: vendor.id });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new AppError(409, "SLUG_EXISTS", "A product with this slug already exists");
    }
    throw error;
  }
}

export async function updateProduct(ownerId: string, productId: string, input: Partial<ProductInput>) {
  const vendor = await approvedVendor(ownerId);
  const product = await Product.findOneAndUpdate({ _id: productId, vendorId: vendor.id, isActive: true }, input, {
    new: true,
    runValidators: true
  });
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  return product;
}

export async function softDeleteProduct(ownerId: string, productId: string): Promise<void> {
  const vendor = await approvedVendor(ownerId);
  const product = await Product.findOneAndUpdate(
    { _id: productId, vendorId: vendor.id, isActive: true },
    { $set: { isActive: false, deletedAt: new Date() } }
  );
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
}

type ProductCursor = { sort: string | number; id: string };
function encodeCursor(value: ProductCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(cursor: string): ProductCursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ProductCursor;
    if (!decoded.id || !["newest", "price", "rating"].includes(typeof decoded.sort === "string" ? decoded.sort : "price")) {
      if (typeof decoded.sort !== "number" && typeof decoded.sort !== "string") throw new Error("invalid");
    }
    return decoded;
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Product cursor is invalid");
  }
}

export async function listProducts(query: {
  q?: string; category?: string; minPrice?: number; maxPrice?: number; vendorId?: string;
  sort: "price" | "newest" | "rating"; cursor?: string; limit: number;
}) {
  const filter: Record<string, unknown> = { isActive: true };
  if (query.q) filter.$text = { $search: query.q };
  if (query.category) filter.category = query.category;
  if (query.vendorId) filter.vendorId = query.vendorId;
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.priceKobo = {
      ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
      ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {})
    };
  }
  const direction = query.sort === "price" ? 1 : -1;
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const sortField = query.sort === "newest" ? "createdAt" : query.sort === "rating" ? "averageRating" : "priceKobo";
  if (cursor) {
    const sortValue = typeof cursor.sort === "number" ? cursor.sort : new Date(cursor.sort).getTime();
    const value = query.sort === "newest" ? new Date(sortValue) : sortValue;
    const operator = direction === 1 ? "$gt" : "$lt";
    filter.$or = [
      { [sortField]: { [operator]: value } },
      { [sortField]: value, _id: { [operator]: new mongoose.Types.ObjectId(cursor.id) } }
    ];
  }
  const rows = await Product.find(filter)
    .sort({ [sortField]: direction, _id: direction })
    .limit(query.limit + 1)
    .lean();
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, -1) : rows;
  const last = items[items.length - 1];
  const sortValue = last ? (query.sort === "newest" ? last.createdAt.toISOString() : query.sort === "rating" ? last.averageRating : last.priceKobo) : undefined;
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ sort: sortValue!, id: last._id.toString() }) : null
  };
}

export async function getProduct(slug: string) {
  const product = await Product.findOne({ slug, isActive: true }).lean();
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  return product;
}

export async function addReview(buyerId: string, productId: string, rating: number, comment?: string) {
  if (!mongoose.isValidObjectId(productId)) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
  const completed = await sql("order_items as oi")
    .join("sub_orders as so", "so.id", "oi.sub_order_id")
    .where({ "oi.product_id": productId, "so.status": "COMPLETED" })
    .join("orders as o", "o.id", "oi.order_id")
    .andWhere("o.buyer_id", buyerId)
    .first("oi.id");
  if (!completed) throw new AppError(403, "REVIEW_NOT_ELIGIBLE", "A completed purchase is required to review this product");
  try {
    await Review.create({ productId: product._id, buyerId, rating, comment });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new AppError(409, "REVIEW_EXISTS", "You have already reviewed this product");
    }
    throw error;
  }
  const [aggregate] = await Review.aggregate([
    { $match: { productId: product._id } },
    { $group: { _id: "$productId", average: { $avg: "$rating" }, count: { $sum: 1 } } }
  ]);
  product.averageRating = aggregate.average;
  product.reviewCount = aggregate.count;
  await product.save();
  return { averageRating: product.averageRating, reviewCount: product.reviewCount };
}
