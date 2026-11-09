import mongoose from "mongoose";
import { AppError } from "../middleware/errors";
import { Cart } from "../models/cart.model";
import { Product } from "../models/product.model";

async function getCurrentPrice(productId: string, variantSku?: string) {
  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Active product not found");
  if (variantSku) {
    const variant = product.variants.find((entry) => entry.sku === variantSku);
    if (!variant) throw new AppError(404, "VARIANT_NOT_FOUND", "Product variant not found");
    return { product, priceKobo: variant.priceKobo, stock: variant.stock };
  }
  if (product.variants.length) throw new AppError(400, "VARIANT_REQUIRED", "Select a product variant");
  return { product, priceKobo: product.priceKobo, stock: product.stock };
}

export async function getCart(userId: string) {
  return Cart.findOne({ userId }).populate("items.productId", "name slug images isActive").lean();
}

export async function addItem(userId: string, productId: string, quantity: number, variantSku?: string) {
  if (!mongoose.isValidObjectId(productId)) throw new AppError(400, "INVALID_PRODUCT_ID", "Product ID is invalid");
  const { priceKobo, stock } = await getCurrentPrice(productId, variantSku);
  if (quantity > stock) throw new AppError(409, "INSUFFICIENT_STOCK", "Requested quantity exceeds available stock");
  let cart = await Cart.findOne({ userId });
  if (!cart) cart = new Cart({ userId, items: [] });
  const existing = cart.items.find((item) => item.productId.toString() === productId && item.variantSku === variantSku);
  if (existing) {
    if (existing.quantity + quantity > stock) throw new AppError(409, "INSUFFICIENT_STOCK", "Requested quantity exceeds available stock");
    existing.quantity += quantity;
    existing.priceAtAddKobo = priceKobo;
  } else {
    cart.items.push({ productId: new mongoose.Types.ObjectId(productId), variantSku, quantity, priceAtAddKobo: priceKobo });
  }
  await cart.save();
  return cart;
}

export async function updateItem(userId: string, itemId: string, quantity: number) {
  const cart = await Cart.findOne({ userId });
  const item = cart?.items.id(itemId);
  if (!cart || !item) throw new AppError(404, "CART_ITEM_NOT_FOUND", "Cart item not found");
  const current = await getCurrentPrice(item.productId.toString(), item.variantSku ?? undefined);
  if (quantity > current.stock) throw new AppError(409, "INSUFFICIENT_STOCK", "Requested quantity exceeds available stock");
  item.quantity = quantity;
  item.priceAtAddKobo = current.priceKobo;
  await cart.save();
  return cart;
}

export async function removeItem(userId: string, itemId: string): Promise<void> {
  const cart = await Cart.findOne({ userId });
  const item = cart?.items.id(itemId);
  if (!cart || !item) throw new AppError(404, "CART_ITEM_NOT_FOUND", "Cart item not found");
  item.deleteOne();
  await cart.save();
}
