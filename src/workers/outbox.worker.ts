import { sql } from "../db/postgres";
import { logger } from "../logger";
import { Cart } from "../models/cart.model";
import { Notification } from "../models/notification.model";
import type { StockAdjustment } from "../services/order.service";
import { restoreOutboxStock } from "../services/order.service";

type OutboxEvent = { id: string; event_type: string; payload: Record<string, unknown> };

async function notify(event: OutboxEvent, userId: string, type: string, message: string, data: Record<string, unknown>): Promise<void> {
  await Notification.updateOne(
    { sourceEventId: `${event.id}:${userId}` },
    { $setOnInsert: { userId, sourceEventId: `${event.id}:${userId}`, type, message, data } },
    { upsert: true }
  );
}

async function handleEvent(event: OutboxEvent): Promise<void> {
  const payload = event.payload;
  switch (event.event_type) {
    case "CART_CHECKOUT_COMPLETED":
      await Cart.updateOne(
        { userId: payload.userId },
        { $pull: { items: { _id: { $in: payload.itemIds } } } }
      );
      return;
    case "RESTORE_STOCK":
      await restoreOutboxStock(event.id, payload.lines as StockAdjustment[]);
      return;
    case "RESTORE_CANCELLED_STOCK":
      await restoreOutboxStock(event.id, payload.items as StockAdjustment[]);
      return;
    case "ORDER_PLACED":
      await notify(event, String(payload.userId), "order_placed", "Your order has been placed.", { orderId: payload.orderId });
      return;
    case "ORDER_SHIPPED":
      await notify(event, String(payload.buyerId), "order_shipped", "A vendor has shipped your order.", { orderId: payload.orderId, subOrderId: payload.subOrderId });
      return;
    case "FUNDS_RELEASED":
      await notify(event, String(payload.vendorId), "funds_released", "Escrow funds were released to your wallet.", { orderId: payload.orderId, amountKobo: payload.amountKobo });
      return;
    case "ORDER_COMPLETED":
      await notify(event, String(payload.buyerId), "order_completed", "Your order is complete.", { orderId: payload.orderId });
      return;
    case "DISPUTE_OPENED": {
      const subOrder = await sql("sub_orders").where({ id: payload.subOrderId }).first("vendor_id");
      if (!subOrder) throw new Error(`Sub-order missing for dispute event ${event.id}`);
      await Promise.all([
        notify(event, String(payload.buyerId), "dispute_opened", "Your dispute has been opened.", { disputeId: payload.disputeId }),
        notify(event, String(subOrder.vendor_id), "dispute_opened", "A buyer opened a dispute on your order.", { disputeId: payload.disputeId })
      ]);
      return;
    }
    case "DISPUTE_RESOLVED":
      await Promise.all([
        notify(event, String(payload.buyerId), "dispute_resolved", "Your dispute has been resolved.", { disputeId: payload.disputeId, resolution: payload.resolution }),
        notify(event, String(payload.vendorId), "dispute_resolved", "A dispute on your order has been resolved.", { disputeId: payload.disputeId, resolution: payload.resolution })
      ]);
      return;
    case "PAYOUT_SUCCESS":
      await notify(event, String(payload.vendorId), "payout_success", "Your payout was successful.", { payoutId: payload.payoutId, amountKobo: payload.amountKobo });
      return;
    case "PAYOUT_FAILURE":
      await notify(event, String(payload.vendorId), "payout_failure", "Your payout failed and the funds were returned to your wallet.", { payoutId: payload.payoutId, amountKobo: payload.amountKobo });
      return;
    default:
      throw new Error(`Unsupported outbox event type: ${event.event_type}`);
  }
}

export async function processOneOutboxEvent(): Promise<boolean> {
  let selected: OutboxEvent | undefined;
  try {
    await sql.transaction(async (trx) => {
      const row = await trx("outbox_events").whereNull("processed_at").orderBy("created_at").forUpdate().skipLocked().first();
      if (!row) return;
      const event: OutboxEvent = {
        id: row.id,
        event_type: row.event_type,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
      };
      selected = event;
      await handleEvent(event);
      await trx("outbox_events").where({ id: row.id }).update({ processed_at: trx.fn.now(), last_error: null });
    });
    return Boolean(selected);
  } catch (error) {
    if (selected) {
      logger.error({ err: error, outboxEventId: selected.id, eventType: selected.event_type }, "Outbox event processing failed");
      await sql("outbox_events").where({ id: selected.id }).update({
        attempts: sql.raw("attempts + 1"),
        last_error: String(error)
      });
    }
    throw error;
  }
}

export async function drainOutbox(limit = 100): Promise<number> {
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    if (!await processOneOutboxEvent()) break;
    processed += 1;
  }
  return processed;
}
