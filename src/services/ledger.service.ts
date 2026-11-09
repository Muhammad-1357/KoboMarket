import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { AppError } from "../middleware/errors";

function assertKobo(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError(400, "INVALID_AMOUNT", "Amount must be a positive integer number of kobo");
  }
}

export async function accountForUser(trx: Knex.Transaction, userId: string, lock = false): Promise<{ id: string; balance: number; status: string }> {
  let query = trx("accounts").where({ owner_type: "user", owner_id: userId });
  if (lock) query = query.forUpdate();
  const account = await query.first();
  if (!account) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
  const balance = Number(account.balance_kobo);
  if (!Number.isSafeInteger(balance)) throw new AppError(500, "BALANCE_RANGE_ERROR", "Wallet balance exceeds safe integer range");
  return { id: account.id, balance, status: account.status };
}

export async function systemAccount(trx: Knex.Transaction, ownerId: string): Promise<string> {
  const account = await trx("accounts").where({ owner_type: "system", owner_id: ownerId }).first("id");
  if (!account) throw new AppError(500, "SYSTEM_ACCOUNT_MISSING", `System account ${ownerId} is not configured`);
  return account.id;
}

export async function createTransaction(
  trx: Knex.Transaction,
  input: { type: string; reference?: string; idempotencyKey?: string; metadata?: Record<string, unknown>; status?: "pending" | "succeeded" | "failed" }
): Promise<{ id: string; reference: string }> {
  const reference = input.reference ?? `KM-${randomUUID()}`;
  const [row] = await trx("transactions").insert({
    reference,
    type: input.type,
    status: input.status ?? "pending",
    idempotency_key: input.idempotencyKey,
    metadata: JSON.stringify(input.metadata ?? {})
  }).returning(["id", "reference"]);
  return row;
}

export async function postTransfer(
  trx: Knex.Transaction,
  input: { transactionId: string; debitAccountId: string; creditAccountId: string; amountKobo: number }
): Promise<void> {
  assertKobo(input.amountKobo);
  if (input.debitAccountId === input.creditAccountId) {
    throw new AppError(400, "INVALID_TRANSFER", "A transfer requires two distinct accounts");
  }
  const accounts = await trx("accounts")
    .whereIn("id", [input.debitAccountId, input.creditAccountId])
    .orderBy("id")
    .forUpdate();
  if (accounts.length !== 2) throw new AppError(404, "ACCOUNT_NOT_FOUND", "A ledger account was not found");
  const debit = accounts.find((account) => account.id === input.debitAccountId)!;
  const credit = accounts.find((account) => account.id === input.creditAccountId)!;
  const debitBalance = Number(debit.balance_kobo);
  const creditBalance = Number(credit.balance_kobo);
  if (!Number.isSafeInteger(debitBalance) || !Number.isSafeInteger(creditBalance)) {
    throw new AppError(500, "BALANCE_RANGE_ERROR", "Account balance exceeds safe integer range");
  }
  if (debit.owner_id !== "PLATFORM_FUNDING_SOURCE" && debitBalance < input.amountKobo) {
    throw new AppError(409, "INSUFFICIENT_FUNDS", "Insufficient wallet balance");
  }
  if (creditBalance + input.amountKobo > Number.MAX_SAFE_INTEGER) {
    throw new AppError(409, "BALANCE_LIMIT", "Transfer exceeds supported balance limit");
  }
  await trx("ledger_entries").insert([
    { transaction_id: input.transactionId, account_id: input.debitAccountId, direction: "debit", amount_kobo: input.amountKobo },
    { transaction_id: input.transactionId, account_id: input.creditAccountId, direction: "credit", amount_kobo: input.amountKobo }
  ]);
  await trx("accounts").where({ id: input.debitAccountId }).update({
    balance_kobo: trx.raw("balance_kobo - ?", [input.amountKobo])
  });
  await trx("accounts").where({ id: input.creditAccountId }).update({
    balance_kobo: trx.raw("balance_kobo + ?", [input.amountKobo])
  });
}
