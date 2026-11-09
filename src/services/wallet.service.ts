import { createHash, randomUUID } from "node:crypto";
import { sql } from "../db/postgres";
import { AppError } from "../middleware/errors";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "./ledger.service";
import { isValidMockWebhook, mockWebhookSignature, verifyMockFunding } from "./mock-provider.service";

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function initializeFunding(userId: string, amountKobo: number, idempotencyKey: string): Promise<{ reference: string; checkoutUrl: string }> {
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 100) {
    throw new AppError(400, "INVALID_AMOUNT", "Funding amount must be at least 100 kobo");
  }
  const bodyHash = requestHash({ userId, amountKobo });
  return sql.transaction(async (trx) => {
    const existing = await trx("transactions").where({ idempotency_key: idempotencyKey }).first();
    if (existing) {
      const metadata = typeof existing.metadata === "string" ? JSON.parse(existing.metadata) : existing.metadata;
      if (metadata.requestHash !== bodyHash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request");
      return { reference: existing.reference, checkoutUrl: `mock://checkout/${existing.reference}` };
    }
    const reference = `FUND-${randomUUID()}`;
    const transaction = await createTransaction(trx, {
      type: "WALLET_FUNDING",
      reference,
      idempotencyKey,
      metadata: { userId, amountKobo, requestHash: bodyHash }
    });
    return { reference: transaction.reference, checkoutUrl: `mock://checkout/${transaction.reference}` };
  });
}

export function signMockWebhook(rawBody: Buffer): string {
  return mockWebhookSignature(rawBody);
}

export async function processFundingWebhook(rawBody: Buffer, signature: string | undefined, payload: unknown): Promise<{ credited: boolean }> {
  if (!signature) throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature is required");
  if (!isValidMockWebhook(rawBody, signature)) {
    throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature is invalid");
  }
  const parsed = payload as { event?: string; data?: { reference?: string; amountKobo?: number } };
  const reference = parsed.data?.reference;
  const amountKobo = parsed.data?.amountKobo;
  if (parsed.event !== "charge.success" || !reference || typeof amountKobo !== "number" || !Number.isSafeInteger(amountKobo)) {
    throw new AppError(400, "INVALID_WEBHOOK", "Webhook payload is invalid");
  }

  return sql.transaction(async (trx) => {
    const payment = await trx("transactions").where({ reference }).forUpdate().first();
    if (!payment || payment.type !== "WALLET_FUNDING") throw new AppError(404, "PAYMENT_NOT_FOUND", "Funding payment was not found");
    if (payment.status === "succeeded") return { credited: false };
    if (payment.status !== "pending") throw new AppError(409, "PAYMENT_NOT_PENDING", "Funding payment is not pending");
    const metadata = typeof payment.metadata === "string" ? JSON.parse(payment.metadata) : payment.metadata;
    if (metadata.amountKobo !== amountKobo) throw new AppError(400, "AMOUNT_MISMATCH", "Webhook amount does not match the initialized payment");
    if (!await verifyMockFunding(payment.reference, amountKobo)) {
      throw new AppError(400, "PAYMENT_VERIFICATION_FAILED", "Mock payment provider could not verify this funding");
    }

    const account = await accountForUser(trx, metadata.userId);
    if (account.status !== "active") throw new AppError(403, "WALLET_FROZEN", "Wallet is not active");
    const fundingSource = await systemAccount(trx, "PLATFORM_FUNDING_SOURCE");
    await postTransfer(trx, {
      transactionId: payment.id,
      debitAccountId: fundingSource,
      creditAccountId: account.id,
      amountKobo: metadata.amountKobo
    });
    await trx("transactions").where({ id: payment.id }).update({ status: "succeeded" });
    return { credited: true };
  });
}

export async function getWallet(userId: string): Promise<{ balanceKobo: number; currency: string }> {
  return sql.transaction(async (trx) => {
    const account = await accountForUser(trx, userId);
    return { balanceKobo: account.balance, currency: "NGN" };
  });
}

export async function listLedger(userId: string, cursor?: string, limit = 25): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const account = await sql("accounts").where({ owner_type: "user", owner_id: userId }).first("id");
  if (!account) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
  let query = sql("ledger_entries as le")
    .join("transactions as t", "t.id", "le.transaction_id")
    .where("le.account_id", account.id)
    .select("le.id", "le.direction", "le.amount_kobo", "le.created_at", "t.reference", "t.type", "t.status")
    .orderBy("le.created_at", "desc")
    .orderBy("le.id", "desc")
    .limit(Math.min(Math.max(limit, 1), 100) + 1);
  if (cursor) query = query.where("le.id", "<", cursor);
  const rows = await query;
  const hasMore = rows.length > Math.min(Math.max(limit, 1), 100);
  const items = hasMore ? rows.slice(0, -1) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
