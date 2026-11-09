import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TYPE account_owner_type AS ENUM ('user', 'system')`);
  await knex.raw(`CREATE TYPE transaction_status AS ENUM ('pending', 'succeeded', 'failed')`);
  await knex.raw(`CREATE TYPE order_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED')`);
  await knex.raw(`CREATE TYPE payout_status AS ENUM ('PENDING', 'SUCCESS', 'FAILED')`);

  await knex.schema.createTable("accounts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.specificType("owner_type", "account_owner_type").notNullable();
    table.string("owner_id").notNullable();
    table.string("currency", 3).notNullable().defaultTo("NGN");
    table.bigInteger("balance_kobo").notNullable().defaultTo(0);
    table.string("status").notNullable().defaultTo("active");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["owner_type", "owner_id", "currency"]);
    table.index(["owner_type", "owner_id"]);
  });
  await knex.raw("ALTER TABLE accounts ADD CONSTRAINT accounts_balance_nonnegative CHECK (balance_kobo >= 0 OR owner_id = 'PLATFORM_FUNDING_SOURCE')");
  await knex.raw(`INSERT INTO accounts (owner_type, owner_id) VALUES
    ('system', 'PLATFORM_ESCROW'), ('system', 'PLATFORM_REVENUE'),
    ('system', 'PLATFORM_PAYOUT_CLEARING'), ('system', 'PLATFORM_FUNDING_SOURCE'),
    ('system', 'EXTERNAL_PAYOUT')`);

  await knex.schema.createTable("transactions", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("reference").notNullable().unique();
    table.string("type").notNullable();
    table.specificType("status", "transaction_status").notNullable().defaultTo("pending");
    table.string("idempotency_key").unique();
    table.jsonb("metadata").notNullable().defaultTo("{}");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("ledger_entries", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("transaction_id").notNullable().references("id").inTable("transactions").onDelete("RESTRICT");
    table.uuid("account_id").notNullable().references("id").inTable("accounts").onDelete("RESTRICT");
    table.enu("direction", ["debit", "credit"]).notNullable();
    table.bigInteger("amount_kobo").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["account_id", "created_at"]);
  });
  await knex.raw("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_amount_positive CHECK (amount_kobo > 0)");
  await knex.raw(`
    CREATE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'ledger entries are append-only'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
    CREATE FUNCTION ensure_transaction_balanced() RETURNS trigger AS $$
    DECLARE debit_total NUMERIC; credit_total NUMERIC;
    BEGIN
      SELECT COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'debit'), 0),
             COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'credit'), 0)
        INTO debit_total, credit_total
        FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
      IF debit_total <> credit_total THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced', NEW.transaction_id;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER ledger_transaction_balanced
      AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ensure_transaction_balanced();
  `);
  await knex.schema.createTable("orders", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("buyer_id").notNullable();
    table.string("status").notNullable().defaultTo("PAID");
    table.bigInteger("total_kobo").notNullable();
    table.string("idempotency_key").notNullable().unique();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("shipped_at", { useTz: true });
  });
  await knex.raw("ALTER TABLE orders ADD CONSTRAINT orders_total_nonnegative CHECK (total_kobo >= 0)");
  await knex.schema.createTable("sub_orders", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("order_id").notNullable().references("id").inTable("orders").onDelete("RESTRICT");
    table.string("vendor_id").notNullable();
    table.bigInteger("total_kobo").notNullable();
    table.specificType("status", "order_status").notNullable().defaultTo("PAID");
    table.timestamp("shipped_at", { useTz: true });
    table.timestamp("delivered_at", { useTz: true });
    table.timestamp("completed_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["order_id", "vendor_id"]);
    table.index(["vendor_id", "status"]);
  });
  await knex.schema.createTable("order_items", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("order_id").notNullable().references("id").inTable("orders").onDelete("RESTRICT");
    table.uuid("sub_order_id").notNullable().references("id").inTable("sub_orders").onDelete("RESTRICT");
    table.string("product_id").notNullable();
    table.string("product_name").notNullable();
    table.integer("quantity").notNullable();
    table.bigInteger("unit_price_kobo").notNullable();
    table.string("variant_sku");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["sub_order_id"]);
  });
  await knex.raw("ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0)");
  await knex.raw("ALTER TABLE order_items ADD CONSTRAINT order_items_price_nonnegative CHECK (unit_price_kobo >= 0)");
  await knex.schema.createTable("payouts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("vendor_account_id").notNullable().references("id").inTable("accounts").onDelete("RESTRICT");
    table.string("vendor_id").notNullable();
    table.bigInteger("amount_kobo").notNullable();
    table.string("idempotency_key").notNullable().unique();
    table.string("request_hash").notNullable();
    table.specificType("status", "payout_status").notNullable().defaultTo("PENDING");
    table.string("provider_reference");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["vendor_id", "status"]);
  });
  await knex.raw("ALTER TABLE payouts ADD CONSTRAINT payouts_amount_positive CHECK (amount_kobo > 0)");
  await knex.raw("CREATE UNIQUE INDEX one_pending_payout_per_vendor ON payouts (vendor_id) WHERE status = 'PENDING'");
  await knex.schema.createTable("disputes", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("sub_order_id").notNullable().references("id").inTable("sub_orders").onDelete("RESTRICT").unique();
    table.string("buyer_id").notNullable();
    table.text("reason").notNullable();
    table.jsonb("evidence").notNullable().defaultTo("[]");
    table.string("status").notNullable().defaultTo("OPEN");
    table.string("resolution");
    table.bigInteger("refund_amount_kobo");
    table.string("resolved_by");
    table.text("resolution_note");
    table.timestamp("resolved_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("settings", (table) => {
    table.string("key").primary();
    table.jsonb("value").notNullable();
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("idempotency_records", (table) => {
    table.string("key").primary();
    table.string("scope").notNullable();
    table.string("request_hash").notNullable();
    table.jsonb("response").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("outbox_events", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.string("event_type").notNullable();
    table.jsonb("payload").notNullable();
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("last_error");
    table.timestamp("processed_at", { useTz: true });
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["processed_at", "created_at"]);
  });
  await knex.raw(`
    CREATE FUNCTION enforce_sub_order_transition() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = NEW.status THEN RETURN NEW; END IF;
      IF (OLD.status = 'PAID' AND NEW.status IN ('SHIPPED', 'CANCELLED'))
        OR (OLD.status = 'SHIPPED' AND NEW.status IN ('DELIVERED', 'COMPLETED', 'DISPUTED'))
        OR (OLD.status = 'DELIVERED' AND NEW.status IN ('COMPLETED', 'DISPUTED'))
        OR (OLD.status = 'DISPUTED' AND NEW.status IN ('COMPLETED', 'CANCELLED')) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid sub-order state transition: % -> %', OLD.status, NEW.status;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER sub_order_transition_guard BEFORE UPDATE OF status ON sub_orders
      FOR EACH ROW EXECUTE FUNCTION enforce_sub_order_transition();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS sub_order_transition_guard ON sub_orders");
  await knex.raw("DROP FUNCTION IF EXISTS enforce_sub_order_transition()");
  await knex.schema.dropTableIfExists("outbox_events");
  await knex.schema.dropTableIfExists("idempotency_records");
  await knex.schema.dropTableIfExists("settings");
  await knex.schema.dropTableIfExists("disputes");
  await knex.raw("DROP INDEX IF EXISTS one_pending_payout_per_vendor");
  await knex.schema.dropTableIfExists("payouts");
  await knex.schema.dropTableIfExists("order_items");
  await knex.schema.dropTableIfExists("sub_orders");
  await knex.schema.dropTableIfExists("orders");
  await knex.raw("DROP TRIGGER IF EXISTS ledger_transaction_balanced ON ledger_entries");
  await knex.raw("DROP FUNCTION IF EXISTS ensure_transaction_balanced()");
  await knex.schema.dropTableIfExists("ledger_entries");
  await knex.raw("DROP FUNCTION IF EXISTS reject_ledger_mutation()");
  await knex.schema.dropTableIfExists("transactions");
  await knex.schema.dropTableIfExists("accounts");
  await knex.raw("DROP TYPE IF EXISTS payout_status");
  await knex.raw("DROP TYPE IF EXISTS order_status");
  await knex.raw("DROP TYPE IF EXISTS transaction_status");
  await knex.raw("DROP TYPE IF EXISTS account_owner_type");
}
