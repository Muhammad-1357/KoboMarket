import { sql } from "../db/postgres";
import { config } from "../config";
import { AppError } from "../middleware/errors";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "./ledger.service";

export async function openDispute(
  buyerId: string,
  subOrderId: string,
  reason: string,
  evidence: string[]
): Promise<{ id: string; status: string }> {
  return sql.transaction(async (trx) => {
    const subOrder = await trx("sub_orders as so")
      .join("orders as o", "o.id", "so.order_id")
      .where({ "so.id": subOrderId, "o.buyer_id": buyerId })
      .forUpdate("so")
      .first("so.id", "so.order_id", "so.status");
    if (!subOrder) throw new AppError(404, "SUB_ORDER_NOT_FOUND", "Sub-order not found");
    if (!["SHIPPED", "DELIVERED"].includes(subOrder.status)) {
      throw new AppError(409, "INVALID_DISPUTE_STATE", "A dispute can only be opened for shipped or delivered orders");
    }
    try {
      const [dispute] = await trx("disputes").insert({
        sub_order_id: subOrder.id,
        buyer_id: buyerId,
        reason,
        evidence: JSON.stringify(evidence),
        status: "OPEN"
      }).returning(["id", "status"]);
      await trx("sub_orders").where({ id: subOrder.id }).update({ status: "DISPUTED" });
      await trx("orders").where({ id: subOrder.order_id }).update({ status: "DISPUTED" });
      await trx("outbox_events").insert({
        event_type: "DISPUTE_OPENED",
        payload: JSON.stringify({ buyerId, subOrderId, disputeId: dispute.id })
      });
      return dispute;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new AppError(409, "DISPUTE_EXISTS", "A dispute already exists for this sub-order");
      }
      throw error;
    }
  });
}

export async function listDisputes(): Promise<unknown[]> {
  return sql("disputes as d")
    .join("sub_orders as so", "so.id", "d.sub_order_id")
    .select("d.*", "so.vendor_id", "so.total_kobo", "so.order_id")
    .orderBy("d.created_at", "desc");
}

export async function resolveDispute(
  disputeId: string,
  adminId: string,
  resolution: "full_refund" | "partial_refund" | "reject",
  note: string,
  refundAmountKobo?: number
): Promise<void> {
  await sql.transaction(async (trx) => {
    const dispute = await trx("disputes as d")
      .join("sub_orders as so", "so.id", "d.sub_order_id")
      .where("d.id", disputeId)
      .forUpdate("d", "so")
      .first("d.*", "so.vendor_id", "so.total_kobo", "so.order_id", "so.id as sub_order_id");
    if (!dispute) throw new AppError(404, "DISPUTE_NOT_FOUND", "Dispute not found");
    if (dispute.status !== "OPEN") throw new AppError(409, "DISPUTE_ALREADY_RESOLVED", "Dispute is already resolved");
    const total = Number(dispute.total_kobo);
    const buyer = await accountForUser(trx, dispute.buyer_id, true);
    const escrow = await systemAccount(trx, "PLATFORM_ESCROW");
    let refund = 0;
    let vendorGross = 0;
    if (resolution === "full_refund") {
      refund = total;
    } else if (resolution === "partial_refund") {
      if (!Number.isSafeInteger(refundAmountKobo) || refundAmountKobo! <= 0 || refundAmountKobo! >= total) {
        throw new AppError(400, "INVALID_REFUND_AMOUNT", "Partial refund must be a positive amount less than the sub-order total");
      }
      refund = refundAmountKobo!;
      vendorGross = total - refund;
    } else {
      vendorGross = total;
    }

    if (refund > 0) {
      const transaction = await createTransaction(trx, {
        type: resolution === "partial_refund" ? "PARTIAL_REFUND" : "FULL_REFUND",
        status: "succeeded",
        metadata: { disputeId, amountKobo: refund }
      });
      await postTransfer(trx, {
        transactionId: transaction.id,
        debitAccountId: escrow,
        creditAccountId: buyer.id,
        amountKobo: refund
      });
    }
    if (vendorGross > 0) {
      const bpsSetting = await trx("settings").where({ key: "commission_bps" }).first("value");
      const bps = bpsSetting ? Number(typeof bpsSetting.value === "string" ? JSON.parse(bpsSetting.value) : bpsSetting.value) : config.commissionBps;
      const commission = Number((BigInt(vendorGross) * BigInt(bps)) / 10000n);
      const vendorAmount = vendorGross - commission;
      const vendor = await accountForUser(trx, dispute.vendor_id, true);
      if (vendorAmount > 0) {
        const transfer = await createTransaction(trx, {
          type: "DISPUTE_VENDOR_RELEASE", status: "succeeded", metadata: { disputeId, amountKobo: vendorAmount }
        });
        await postTransfer(trx, { transactionId: transfer.id, debitAccountId: escrow, creditAccountId: vendor.id, amountKobo: vendorAmount });
      }
      if (commission > 0) {
        const revenue = await systemAccount(trx, "PLATFORM_REVENUE");
        const transfer = await createTransaction(trx, {
          type: "DISPUTE_COMMISSION", status: "succeeded", metadata: { disputeId, amountKobo: commission }
        });
        await postTransfer(trx, { transactionId: transfer.id, debitAccountId: escrow, creditAccountId: revenue, amountKobo: commission });
      }
    }
    const finalStatus = resolution === "full_refund" ? "CANCELLED" : "COMPLETED";
    await trx("sub_orders").where({ id: dispute.sub_order_id }).update({
      status: finalStatus,
      ...(finalStatus === "COMPLETED" ? { completed_at: trx.fn.now() } : {})
    });
    await trx("disputes").where({ id: disputeId }).update({
      status: "RESOLVED",
      resolution,
      refund_amount_kobo: refund,
      resolved_by: adminId,
      resolution_note: note,
      resolved_at: trx.fn.now()
    });
    const statuses = await trx("sub_orders").where({ order_id: dispute.order_id }).select("status");
    const parentStatus = statuses.every((row) => row.status === "COMPLETED") ? "COMPLETED"
      : statuses.every((row) => ["COMPLETED", "CANCELLED"].includes(row.status)) ? "COMPLETED"
        : statuses.some((row) => row.status === "DISPUTED") ? "DISPUTED" : "PAID";
    await trx("orders").where({ id: dispute.order_id }).update({ status: parentStatus });
    await trx("outbox_events").insert({
      event_type: "DISPUTE_RESOLVED",
      payload: JSON.stringify({ buyerId: dispute.buyer_id, vendorId: dispute.vendor_id, disputeId, resolution })
    });
  });
}
