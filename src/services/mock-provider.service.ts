import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "../db/postgres";
import { config } from "../config";

export async function verifyMockFunding(reference: string, amountKobo: number): Promise<boolean> {
  const payment = await sql("transactions").where({ reference, type: "WALLET_FUNDING", status: "pending" }).first();
  if (!payment) return false;
  const metadata = typeof payment.metadata === "string" ? JSON.parse(payment.metadata) : payment.metadata;
  return metadata.amountKobo === amountKobo;
}

export function mockWebhookSignature(rawBody: Buffer): string {
  return createHmac("sha512", config.webhookSecret).update(rawBody).digest("hex");
}

export function isValidMockWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(mockWebhookSignature(rawBody), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function transferMockPayout(bankAccountNumber: string): Promise<{ success: boolean; providerReference: string }> {
  return {
    success: !bankAccountNumber.endsWith("0000"),
    providerReference: `MOCK-${createHash("sha256").update(bankAccountNumber).digest("hex").slice(0, 20)}`
  };
}
