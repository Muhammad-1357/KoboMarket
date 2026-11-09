import { createHash } from "node:crypto";
import { sql } from "../db/postgres";
import { config } from "../config";
import { AppError } from "../middleware/errors";
import { Vendor } from "../models/vendor.model";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "./ledger.service";
import { transferMockPayout } from "./mock-provider.service";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function requestPayout(
  vendorId: string,
  amountKobo: number,
  idempotencyKey: string
): Promise<{ id: string; amountKobo: number; status: string }> {
  if (!Number.isSafeInteger(amountKobo) || amountKobo < config.payoutMinimumKobo) {
    throw new AppError(400, "PAYOUT_MINIMUM", `Payout minimum is ${config.payoutMinimumKobo} kobo`);
  }
  const vendor = await Vendor.findOne({ ownerId: vendorId, status: "approved" });
  if (!vendor) throw new AppError(403, "VENDOR_NOT_APPROVED", "An approved vendor store is required");
  const requestHash = hash({ vendorId, amountKobo });

  try {
    return await sql.transaction(async (trx) => {
      const previous = await trx("payouts").where({ idempotency_key: idempotencyKey }).first();
      if (previous) {
        if (previous.vendor_id !== vendorId || previous.request_hash !== requestHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request");
        }
        return { id: previous.id, amountKobo: Number(previous.amount_kobo), status: previous.status };
      }
      const wallet = await accountForUser(trx, vendorId, true);
      if (wallet.status !== "active") throw new AppError(403, "WALLET_FROZEN", "Wallet is not active");
      if (wallet.balance < amountKobo) throw new AppError(409, "INSUFFICIENT_FUNDS", "Wallet balance is insufficient");
      const clearing = await systemAccount(trx, "PLATFORM_PAYOUT_CLEARING");
      const [payout] = await trx("payouts").insert({
        vendor_account_id: wallet.id,
        vendor_id: vendorId,
        amount_kobo: amountKobo,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        status: "PENDING"
      }).returning(["id", "amount_kobo", "status"]);
      const transaction = await createTransaction(trx, {
        type: "PAYOUT_REQUEST",
        idempotencyKey: `payout-transfer:${idempotencyKey}`,
        status: "succeeded",
        metadata: { payoutId: payout.id }
      });
      await postTransfer(trx, {
        transactionId: transaction.id,
        debitAccountId: wallet.id,
        creditAccountId: clearing,
        amountKobo
      });
      return { id: payout.id, amountKobo: Number(payout.amount_kobo), status: payout.status };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new AppError(409, "PAYOUT_PENDING", "A pending payout already exists for this vendor");
    }
    throw error;
  }
}

export async function listPayouts(vendorId: string): Promise<unknown[]> {
  return sql("payouts").where({ vendor_id: vendorId }).select("id", "amount_kobo", "status", "provider_reference", "created_at").orderBy("created_at", "desc");
}

export async function processPendingPayouts(): Promise<number> {
  const payouts = await sql("payouts").where({ status: "PENDING" }).select("id").orderBy("created_at").limit(50);
  let processed = 0;
  for (const { id } of payouts) {
    const outcome = await sql.transaction(async (trx) => {
      const payout = await trx("payouts").where({ id, status: "PENDING" }).forUpdate().skipLocked().first();
      if (!payout) return false;
      const vendor = await Vendor.findOne({ ownerId: payout.vendor_id, status: "approved" }).select("bankDetails").lean();
      if (!vendor) throw new Error(`Approved vendor data missing for payout ${payout.id}`);
      if (!vendor.bankDetails?.accountNumber) throw new AppError(500, "VENDOR_BANK_DETAILS_MISSING", `Bank account missing for payout ${payout.id}`);
      const provider = await transferMockPayout(vendor.bankDetails.accountNumber);
      const clearing = await systemAccount(trx, "PLATFORM_PAYOUT_CLEARING");
      if (provider.success) {
        const external = await systemAccount(trx, "EXTERNAL_PAYOUT");
        const transfer = await createTransaction(trx, {
          type: "PAYOUT_SETTLEMENT", status: "succeeded", metadata: { payoutId: payout.id, providerReference: provider.providerReference }
        });
        await postTransfer(trx, {
          transactionId: transfer.id,
          debitAccountId: clearing,
          creditAccountId: external,
          amountKobo: Number(payout.amount_kobo)
        });
        await trx("payouts").where({ id: payout.id }).update({ status: "SUCCESS", provider_reference: provider.providerReference });
        await trx("outbox_events").insert({
          event_type: "PAYOUT_SUCCESS",
          payload: JSON.stringify({ vendorId: payout.vendor_id, payoutId: payout.id, amountKobo: Number(payout.amount_kobo) })
        });
      } else {
        const reversal = await createTransaction(trx, {
          type: "PAYOUT_REVERSAL", status: "succeeded", metadata: { payoutId: payout.id }
        });
        await postTransfer(trx, {
          transactionId: reversal.id,
          debitAccountId: clearing,
          creditAccountId: payout.vendor_account_id,
          amountKobo: Number(payout.amount_kobo)
        });
        await trx("payouts").where({ id: payout.id }).update({ status: "FAILED", provider_reference: provider.providerReference });
        await trx("outbox_events").insert({
          event_type: "PAYOUT_FAILURE",
          payload: JSON.stringify({ vendorId: payout.vendor_id, payoutId: payout.id, amountKobo: Number(payout.amount_kobo) })
        });
      }
      return true;
    });
    if (outcome) processed += 1;
  }
  return processed;
}
