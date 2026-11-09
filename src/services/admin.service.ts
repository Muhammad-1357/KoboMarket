import { sql } from "../db/postgres";
import { AppError } from "../middleware/errors";
import { User } from "../models/user.model";
import { Vendor } from "../models/vendor.model";
import { listLedger } from "./wallet.service";

export async function searchUsers(search: string | undefined, limit: number) {
  const filter = search ? { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
  const users = await User.find(filter).select("-passwordHash -refreshTokens -verificationTokenHash -resetTokenHash")
    .sort({ createdAt: -1 }).limit(limit).lean();
  return users;
}

export async function freezeUser(userId: string, frozen: boolean): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  if (user.roles.includes("admin") && frozen) throw new AppError(409, "ADMIN_FREEZE_PROTECTED", "An admin account cannot be frozen through this endpoint");
  await sql("accounts").where({ owner_type: "user", owner_id: userId }).update({ status: frozen ? "frozen" : "active" });
  user.status = frozen ? "frozen" : "active";
  await user.save();
}

export async function updateCommission(bps: number): Promise<void> {
  await sql("settings").insert({ key: "commission_bps", value: JSON.stringify(bps) })
    .onConflict("key").merge({ value: JSON.stringify(bps), updated_at: sql.fn.now() });
}

export async function walletLedgerById(id: string, cursor?: string, limit = 25) {
  let account = await sql("accounts").where({ id, owner_type: "user" }).first("owner_id");
  if (!account) account = await sql("accounts").where({ owner_id: id, owner_type: "user" }).first("owner_id");
  if (!account) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
  return listLedger(account.owner_id, cursor, limit);
}

export async function revenueByDay(from: string, to: string) {
  return sql.raw(`
    SELECT DATE(le.created_at) AS day, SUM(le.amount_kobo)::bigint AS revenue_kobo
    FROM ledger_entries le
    JOIN accounts a ON a.id = le.account_id
    WHERE a.owner_type = 'system' AND a.owner_id = 'PLATFORM_REVENUE'
      AND le.direction = 'credit' AND le.created_at >= ?::date AND le.created_at < (?::date + INTERVAL '1 day')
    GROUP BY DATE(le.created_at)
    ORDER BY day
  `, [from, to]);
}

export async function topVendors() {
  return sql.raw(`
    SELECT so.vendor_id, SUM(so.total_kobo)::bigint AS completed_sales_kobo, COUNT(*)::int AS completed_orders
    FROM sub_orders so
    WHERE so.status = 'COMPLETED'
      AND so.completed_at >= DATE_TRUNC('month', CURRENT_DATE)
      AND so.completed_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
    GROUP BY so.vendor_id
    ORDER BY completed_sales_kobo DESC
    LIMIT 10
  `);
}

export async function escrowBalance() {
  const row = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_ESCROW" }).first("balance_kobo");
  if (!row) throw new AppError(500, "SYSTEM_ACCOUNT_MISSING", "Escrow account is missing");
  return Number(row.balance_kobo);
}

export async function reconciliation() {
  return sql.raw(`
    SELECT a.id, a.owner_type, a.owner_id, a.balance_kobo::numeric AS cached_balance_kobo,
      COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE -le.amount_kobo END), 0)::numeric AS ledger_balance_kobo
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    GROUP BY a.id
    HAVING a.balance_kobo::numeric <> COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE -le.amount_kobo END), 0)::numeric
    ORDER BY a.owner_type, a.owner_id
  `);
}

export async function walletTransactions(accountId: string) {
  return sql("ledger_entries as le").join("transactions as t", "t.id", "le.transaction_id")
    .where("le.account_id", accountId)
    .select("le.id", "le.direction", "le.amount_kobo", "le.created_at", "t.reference", "t.type", "t.status")
    .orderBy("le.created_at", "desc");
}

export async function listVendors(search?: string) {
  const filter = search ? { storeName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } : {};
  return Vendor.find(filter).select("-bankDetails").sort({ createdAt: -1 }).limit(100).lean();
}
