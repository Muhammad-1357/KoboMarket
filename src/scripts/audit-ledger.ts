import { closePostgres, sql } from "../db/postgres";

async function audit(): Promise<void> {
  const [unbalanced, mismatches, totals] = await Promise.all([
    sql.raw(`
      SELECT t.id, t.reference,
        COALESCE(SUM(CASE WHEN le.direction = 'debit' THEN le.amount_kobo ELSE 0 END), 0)::numeric AS debits,
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE 0 END), 0)::numeric AS credits
      FROM transactions t
      JOIN ledger_entries le ON le.transaction_id = t.id
      GROUP BY t.id
      HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount_kobo ELSE -le.amount_kobo END) <> 0
    `),
    sql.raw(`
      SELECT a.id, a.owner_type, a.owner_id, a.balance_kobo::numeric AS cached,
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE -le.amount_kobo END), 0)::numeric AS ledger
      FROM accounts a
      LEFT JOIN ledger_entries le ON le.account_id = a.id
      GROUP BY a.id
      HAVING a.balance_kobo::numeric <> COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE -le.amount_kobo END), 0)::numeric
    `),
    sql.raw(`
      SELECT
        COALESCE(SUM(balance_kobo) FILTER (WHERE owner_type = 'user'), 0)::numeric
        + COALESCE(SUM(balance_kobo) FILTER (WHERE owner_type = 'system' AND owner_id IN
          ('PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'PLATFORM_PAYOUT_CLEARING')), 0)::numeric AS held,
        (SELECT COALESCE(SUM((metadata->>'amountKobo')::numeric), 0)
         FROM transactions WHERE type = 'WALLET_FUNDING' AND status = 'succeeded') AS funded,
        (SELECT COALESCE(SUM(amount_kobo), 0)
         FROM payouts WHERE status = 'SUCCESS') AS paid_out
      FROM accounts
    `)
  ]);
  const failures: string[] = [];
  if (unbalanced.rows.length) failures.push(`${unbalanced.rows.length} unbalanced transaction(s)`);
  if (mismatches.rows.length) failures.push(`${mismatches.rows.length} account balance mismatch(es)`);
  const totalsRow = totals.rows[0] as { held: string; funded: string; paid_out: string };
  if (BigInt(totalsRow.held) !== BigInt(totalsRow.funded) - BigInt(totalsRow.paid_out)) {
    failures.push(`money invariant failed (held=${totalsRow.held}, funded=${totalsRow.funded}, paidOut=${totalsRow.paid_out})`);
  }
  if (failures.length) {
    console.error(`FAIL: ${failures.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: ledger entries are balanced, cached balances reconcile, and total money is conserved");
}

audit().catch((error: unknown) => {
  console.error("FAIL: ledger audit could not complete", error);
  process.exitCode = 1;
}).finally(async () => {
  await closePostgres();
});
