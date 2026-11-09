import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import mongoose from "mongoose";
import { config } from "../config";
import { sql } from "../db/postgres";
import { AppError } from "../middleware/errors";
import { Cart } from "../models/cart.model";
import { Product } from "../models/product.model";
import { Vendor } from "../models/vendor.model";
import { logger } from "../logger";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "./ledger.service";

export type StockAdjustment = {
  productId: string;
  quantity: number;
  variantSku?: string;
};

export type CheckoutLine = StockAdjustment & {
  cartItemId: string;
  vendorId: string;
  productName: string;
  unitPriceKobo: number;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function reserve(line: CheckoutLine): Promise<void> {
  const filter: Record<string, unknown> = {
    _id: line.productId,
    isActive: true
  };
  const update: Record<string, unknown> = {};
  if (line.variantSku) {
    filter.variants = { $elemMatch: { sku: line.variantSku, stock: { $gte: line.quantity } } };
    update.$inc = { "variants.$.stock": -line.quantity };
  } else {
    filter.stock = { $gte: line.quantity };
    update.$inc = { stock: -line.quantity };
  }
  const result = await Product.updateOne(filter, update);
  if (result.modifiedCount !== 1) throw new AppError(409, "OUT_OF_STOCK", `Insufficient stock for ${line.productName}`);
}

async function restoreStock(line: CheckoutLine, eventId?: string): Promise<void> {
  const increment = line.variantSku ? { "variants.$.stock": line.quantity } : { stock: line.quantity };
  const filter: Record<string, unknown> = { _id: line.productId };
  if (line.variantSku) filter.variants = { $elemMatch: { sku: line.variantSku } };
  if (eventId) filter.inventoryAdjustmentIds = { $ne: eventId };
  const update: Record<string, unknown> = { $inc: increment };
  if (eventId) update.$addToSet = { inventoryAdjustmentIds: eventId };
  const result = await Product.updateOne(filter, update);
  if (result.matchedCount !== 1) {
    if (eventId && await Product.exists({ _id: line.productId, inventoryAdjustmentIds: eventId })) return;
    throw new Error(`Could not restore stock for ${line.productId}`);
  }
}

export async function restoreOutboxStock(eventId: string, lines: StockAdjustment[]): Promise<void> {
  for (const line of lines) {
    if (!line.productId || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`Invalid stock adjustment in outbox event ${eventId}`);
    }
    await restoreStock({
      cartItemId: "",
      vendorId: "",
      productName: "",
      unitPriceKobo: 0,
      ...line
    }, eventId);
  }
}

async function writeOutbox(eventType: string, payload: Record<string, unknown>): Promise<void> {
  await sql("outbox_events").insert({ event_type: eventType, payload: JSON.stringify(payload) });
}

async function resolveCheckoutLines(userId: string): Promise<CheckoutLine[]> {
  const cart = await Cart.findOne({ userId }).lean();
  if (!cart || cart.items.length === 0) throw new AppError(400, "CART_EMPTY", "Cart is empty");
  const lines: CheckoutLine[] = [];
  for (const item of cart.items) {
    const productId = item.productId.toString();
    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) throw new AppError(409, "PRODUCT_UNAVAILABLE", "A product in your cart is no longer available");
    const vendor = await Vendor.findById(product.vendorId);
    if (!vendor || vendor.status !== "approved") throw new AppError(409, "VENDOR_UNAVAILABLE", "A vendor in your cart is not approved");
    const variant = item.variantSku ? product.variants.find((candidate) => candidate.sku === item.variantSku) : undefined;
    if (item.variantSku && !variant) throw new AppError(409, "VARIANT_UNAVAILABLE", "A selected product variant is no longer available");
    if (!item.variantSku && product.variants.length) throw new AppError(409, "VARIANT_REQUIRED", "Select a product variant before checkout");
    const price = variant?.priceKobo ?? product.priceKobo;
    const stock = variant?.stock ?? product.stock;
    if (stock < item.quantity) throw new AppError(409, "OUT_OF_STOCK", `Insufficient stock for ${product.name}`);
    lines.push({
      cartItemId: item._id.toString(),
      productId,
      vendorId: vendor.ownerId,
      productName: product.name,
      quantity: item.quantity,
      unitPriceKobo: price,
      ...(item.variantSku ? { variantSku: item.variantSku } : {})
    });
  }
  return lines;
}

export async function checkout(userId: string, idempotencyKey: string): Promise<{ orderId: string; totalKobo: number; status: string }> {
  const existing = await sql("idempotency_records").where({ key: idempotencyKey, scope: `checkout:${userId}` }).first();
  const cart = await Cart.findOne({ userId }).lean();
  if (existing && (!cart || cart.items.length === 0)) {
    return typeof existing.response === "string" ? JSON.parse(existing.response) : existing.response;
  }

  const lines = await resolveCheckoutLines(userId);
  const total = lines.reduce((sum, line) => sum + line.unitPriceKobo * line.quantity, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new AppError(400, "INVALID_ORDER_TOTAL", "Order total is invalid");
  const requestHash = hash(lines);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request");
    }
    const response = typeof existing.response === "string" ? JSON.parse(existing.response) : existing.response;
    return response;
  }
  const reserved: CheckoutLine[] = [];
  let orderCommitted = false;
  try {
    for (const line of lines) {
      await reserve(line);
      reserved.push(line);
    }

    const outcome = await sql.transaction(async (trx) => {
        const wallet = await accountForUser(trx, userId, true);
        if (wallet.status !== "active") throw new AppError(403, "WALLET_FROZEN", "Wallet is not active");
        const raced = await trx("idempotency_records").where({ key: idempotencyKey, scope: `checkout:${userId}` }).first();
        if (raced) {
          if (raced.request_hash !== requestHash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request");
          const value = typeof raced.response === "string" ? JSON.parse(raced.response) : raced.response;
          return { result: value as { orderId: string; totalKobo: number; status: string }, duplicate: true };
        }
        if (wallet.balance < total) throw new AppError(409, "INSUFFICIENT_FUNDS", "Wallet balance is insufficient");

        const orderId = randomUUID();
        await trx("orders").insert({
          id: orderId,
          buyer_id: userId,
          status: "PAID",
          total_kobo: total,
          idempotency_key: `checkout:${idempotencyKey}`
        });
        const groups = new Map<string, CheckoutLine[]>();
        for (const line of lines) groups.set(line.vendorId, [...(groups.get(line.vendorId) ?? []), line]);
        const escrow = await systemAccount(trx, "PLATFORM_ESCROW");
        for (const [vendorId, vendorLines] of groups) {
          const subOrderId = randomUUID();
          const subTotal = vendorLines.reduce((sum, line) => sum + line.unitPriceKobo * line.quantity, 0);
          await trx("sub_orders").insert({
            id: subOrderId, order_id: orderId, vendor_id: vendorId, total_kobo: subTotal, status: "PAID"
          });
          await trx("order_items").insert(vendorLines.map((line) => ({
            order_id: orderId,
            sub_order_id: subOrderId,
            product_id: line.productId,
            product_name: line.productName,
            quantity: line.quantity,
            unit_price_kobo: line.unitPriceKobo,
            variant_sku: line.variantSku
          })));
        }
        const orderTransaction = await createTransaction(trx, {
          type: "ORDER_ESCROW",
          idempotencyKey: `checkout-ledger:${idempotencyKey}`,
          status: "succeeded",
          metadata: { orderId }
        });
        await postTransfer(trx, {
          transactionId: orderTransaction.id,
          debitAccountId: wallet.id,
          creditAccountId: escrow,
          amountKobo: total
        });
        const result = { orderId, totalKobo: total, status: "PAID" };
        await trx("idempotency_records").insert({
          key: idempotencyKey,
          scope: `checkout:${userId}`,
          request_hash: requestHash,
          response: JSON.stringify(result)
        });
        await trx("outbox_events").insert({
          event_type: "CART_CHECKOUT_COMPLETED",
          payload: JSON.stringify({ userId, itemIds: lines.map((line) => line.cartItemId), orderId })
        });
        await trx("outbox_events").insert({
          event_type: "ORDER_PLACED",
          payload: JSON.stringify({ userId, orderId })
        });
        return { result, duplicate: false };
    });
    orderCommitted = true;
    if (outcome.duplicate) {
      const failures: CheckoutLine[] = [];
      for (const line of reserved) {
        try {
          await restoreStock(line);
        } catch (error) {
          failures.push(line);
          logger.error({ err: error, productId: line.productId }, "Duplicate checkout stock restoration failed");
        }
      }
      if (failures.length) await writeOutbox("RESTORE_STOCK", { lines: failures });
    }
    return outcome.result;
  } catch (error) {
    if (orderCommitted) throw error;
    const compensationFailures: string[] = [];
    for (const line of reserved) {
      try {
        await restoreStock(line);
      } catch (compensationError) {
        compensationFailures.push(line.productId);
        logger.error({ err: compensationError, productId: line.productId }, "Stock compensation failed");
      }
    }
    if (compensationFailures.length > 0) {
      try {
        await writeOutbox("RESTORE_STOCK", { lines: reserved.filter((line) => compensationFailures.includes(line.productId)) });
      } catch (outboxError) {
        logger.fatal({ err: outboxError, productIds: compensationFailures }, "Could not persist stock compensation event");
      }
    }
    throw error;
  }
}

async function updateParentOrderStatus(trx: Knex.Transaction, orderId: string): Promise<void> {
  const rows = await trx("sub_orders").where({ order_id: orderId }).select("status");
  const statuses = rows.map((row) => row.status as string);
  const status = statuses.every((value) => value === "COMPLETED") ? "COMPLETED"
    : statuses.some((value) => value === "DISPUTED") ? "DISPUTED"
      : statuses.some((value) => value === "SHIPPED" || value === "DELIVERED") ? "SHIPPED"
        : statuses.every((value) => value === "CANCELLED") ? "CANCELLED" : "PAID";
  await trx("orders").where({ id: orderId }).update({ status });
}

async function releaseEscrow(trx: Knex.Transaction, subOrder: { id: string; order_id: string; vendor_id: string; total_kobo: string | number }) {
  const total = Number(subOrder.total_kobo);
  const bpsSetting = await trx("settings").where({ key: "commission_bps" }).first("value");
  const bps = bpsSetting ? Number(typeof bpsSetting.value === "string" ? JSON.parse(bpsSetting.value) : bpsSetting.value) : config.commissionBps;
  const commission = Number((BigInt(total) * BigInt(bps)) / 10000n);
  const vendorAmount = total - commission;
  const escrow = await systemAccount(trx, "PLATFORM_ESCROW");
  const vendorAccount = await accountForUser(trx, subOrder.vendor_id, true);
  if (vendorAmount > 0) {
    const transfer = await createTransaction(trx, {
      type: "ESCROW_RELEASE",
      status: "succeeded",
      metadata: { subOrderId: subOrder.id, recipient: "vendor", amountKobo: vendorAmount }
    });
    await postTransfer(trx, { transactionId: transfer.id, debitAccountId: escrow, creditAccountId: vendorAccount.id, amountKobo: vendorAmount });
  }
  if (commission > 0) {
    const revenue = await systemAccount(trx, "PLATFORM_REVENUE");
    const transfer = await createTransaction(trx, {
      type: "PLATFORM_COMMISSION",
      status: "succeeded",
      metadata: { subOrderId: subOrder.id, amountKobo: commission }
    });
    await postTransfer(trx, { transactionId: transfer.id, debitAccountId: escrow, creditAccountId: revenue, amountKobo: commission });
  }
  await trx("sub_orders").where({ id: subOrder.id }).update({ status: "COMPLETED", completed_at: trx.fn.now() });
  await trx("outbox_events").insert({
    event_type: "FUNDS_RELEASED",
    payload: JSON.stringify({ vendorId: subOrder.vendor_id, orderId: subOrder.order_id, subOrderId: subOrder.id, amountKobo: vendorAmount })
  });
  await updateParentOrderStatus(trx, subOrder.order_id);
}

export async function listOrders(userId: string, role: "buyer" | "vendor"): Promise<unknown[]> {
  let query = sql("orders as o")
    .join("sub_orders as so", "so.order_id", "o.id")
    .select("o.id as orderId", "o.status as orderStatus", "o.total_kobo", "o.created_at", "so.id as subOrderId", "so.vendor_id", "so.total_kobo as subTotalKobo", "so.status as subOrderStatus");
  query = role === "buyer" ? query.where("o.buyer_id", userId) : query.where("so.vendor_id", userId);
  return query.orderBy("o.created_at", "desc");
}

export async function getOrder(userId: string, orderId: string, roles: string[]): Promise<unknown> {
  const order = await sql("orders").where({ id: orderId }).first();
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  const isBuyer = order.buyer_id === userId && roles.includes("buyer");
  const subOrders = await sql("sub_orders").where({ order_id: orderId }).select("*");
  const visibleSubOrders = roles.includes("admin") ? subOrders
    : subOrders.filter((subOrder) => isBuyer || (roles.includes("vendor") && subOrder.vendor_id === userId));
  if (visibleSubOrders.length === 0) throw new AppError(403, "FORBIDDEN", "You cannot access this order");
  const items = await sql("order_items").whereIn("sub_order_id", visibleSubOrders.map((row) => row.id));
  return { ...order, subOrders: visibleSubOrders.map((subOrder) => ({
    ...subOrder,
    items: items.filter((item) => item.sub_order_id === subOrder.id)
  })) };
}

export async function cancelOrder(userId: string, orderId: string): Promise<void> {
  await sql.transaction(async (trx) => {
    const order = await trx("orders").where({ id: orderId, buyer_id: userId }).forUpdate().first();
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const subOrders = await trx("sub_orders").where({ order_id: orderId }).forUpdate();
    if (subOrders.some((subOrder) => subOrder.status !== "PAID")) {
      throw new AppError(409, "INVALID_ORDER_TRANSITION", "An order can only be cancelled before it ships");
    }
    const wallet = await accountForUser(trx, userId, true);
    const escrow = await systemAccount(trx, "PLATFORM_ESCROW");
    const refund = await createTransaction(trx, {
      type: "ORDER_CANCELLATION_REFUND", status: "succeeded", metadata: { orderId }
    });
    await postTransfer(trx, { transactionId: refund.id, debitAccountId: escrow, creditAccountId: wallet.id, amountKobo: Number(order.total_kobo) });
    await trx("sub_orders").where({ order_id: orderId }).update({ status: "CANCELLED" });
    await trx("orders").where({ id: orderId }).update({ status: "CANCELLED" });
    const items = await trx("order_items as oi").join("sub_orders as so", "so.id", "oi.sub_order_id")
      .where("so.order_id", orderId).select("oi.product_id", "oi.quantity", "oi.variant_sku");
    await trx("outbox_events").insert({
      event_type: "RESTORE_CANCELLED_STOCK",
      payload: JSON.stringify({ items: items.map((item) => ({
        productId: item.product_id,
        quantity: item.quantity,
        variantSku: item.variant_sku
      })) })
    });
  });
}

export async function shipSubOrder(vendorId: string, subOrderId: string): Promise<void> {
  await sql.transaction(async (trx) => {
    const subOrder = await trx("sub_orders").where({ id: subOrderId, vendor_id: vendorId }).forUpdate().first();
    if (!subOrder) throw new AppError(404, "SUB_ORDER_NOT_FOUND", "Sub-order not found");
    if (subOrder.status !== "PAID") throw new AppError(409, "INVALID_ORDER_TRANSITION", "Only paid sub-orders can be shipped");
    await trx("sub_orders").where({ id: subOrderId }).update({ status: "SHIPPED", shipped_at: trx.fn.now() });
    await trx("outbox_events").insert({
      event_type: "ORDER_SHIPPED",
      payload: JSON.stringify({ orderId: subOrder.order_id, subOrderId, buyerId: (await trx("orders").where({ id: subOrder.order_id }).first("buyer_id")).buyer_id })
    });
    await updateParentOrderStatus(trx, subOrder.order_id);
  });
}

export async function confirmDelivery(buyerId: string, subOrderId: string): Promise<void> {
  await sql.transaction(async (trx) => {
    const subOrder = await trx("sub_orders as so")
      .join("orders as o", "o.id", "so.order_id")
      .where({ "so.id": subOrderId, "o.buyer_id": buyerId })
      .forUpdate("so")
      .first("so.*");
    if (!subOrder) throw new AppError(404, "SUB_ORDER_NOT_FOUND", "Sub-order not found");
    if (subOrder.status !== "SHIPPED") throw new AppError(409, "INVALID_ORDER_TRANSITION", "Only shipped sub-orders can be confirmed");
    const openDispute = await trx("disputes").where({ sub_order_id: subOrderId, status: "OPEN" }).first();
    if (openDispute) throw new AppError(409, "DISPUTE_OPEN", "This sub-order is frozen by an open dispute");
    await trx("sub_orders").where({ id: subOrderId }).update({ status: "DELIVERED", delivered_at: trx.fn.now() });
    await releaseEscrow(trx, { ...subOrder, status: "DELIVERED" });
    await trx("outbox_events").insert({
      event_type: "ORDER_COMPLETED",
      payload: JSON.stringify({ buyerId, orderId: subOrder.order_id, subOrderId })
    });
  });
}

export async function completeExpiredSubOrders(): Promise<number> {
  const expired = await sql("sub_orders")
    .where({ status: "SHIPPED" })
    .where("shipped_at", "<=", sql.raw("NOW() - (? * INTERVAL '1 hour')", [config.escrowTimeoutHours]))
    .whereNotIn("id", sql("disputes").where({ status: "OPEN" }).select("sub_order_id"))
    .select("id")
    .limit(100);
  let completed = 0;
  for (const row of expired) {
    await sql.transaction(async (trx) => {
      const subOrder = await trx("sub_orders").where({ id: row.id, status: "SHIPPED" }).forUpdate().skipLocked().first();
      if (!subOrder) return;
      const disputed = await trx("disputes").where({ sub_order_id: row.id, status: "OPEN" }).first("id");
      if (disputed) return;
      await releaseEscrow(trx, subOrder);
      completed += 1;
    });
  }
  return completed;
}
