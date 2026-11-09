const dotenv = require("dotenv") as typeof import("dotenv");
dotenv.config({ path: ".env.test" });

const mongoUri = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27018/kobomarket_test";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://kobomarket:kobomarket@127.0.0.1:5433/kobomarket_test";

function assertTestDatabase(uri: string, label: string): void {
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(uri).pathname).replace(/^\/+/, "").split("/")[0] ?? "";
  } catch {
    throw new Error(`${label} must be a valid database URL`);
  }
  if (!databaseName.endsWith("_test")) {
    throw new Error(`${label} must name a database ending in _test; refusing to run destructive test setup`);
  }
}

assertTestDatabase(mongoUri, "TEST_MONGODB_URI");
assertTestDatabase(databaseUrl, "TEST_DATABASE_URL");

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = mongoUri;
process.env.DATABASE_URL = databaseUrl;
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-change-this-to-at-least-32-characters";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-change-this-to-at-least-32-characters";
process.env.WEBHOOK_SECRET ??= "test-webhook-secret-change-this";
process.env.MOCK_PROVIDER_SECRET ??= "test-mock-provider-secret";

require("ts-node/register");

const { connectMongo, closeMongo } = require("../src/db/mongo") as typeof import("../src/db/mongo");
const { sql, closePostgres } = require("../src/db/postgres") as typeof import("../src/db/postgres");
const mongoose = require("mongoose") as typeof import("mongoose");
const { User } = require("../src/models/user.model") as typeof import("../src/models/user.model");
const { LoginAttempt } = require("../src/models/login-attempt.model") as typeof import("../src/models/login-attempt.model");
const { Vendor } = require("../src/models/vendor.model") as typeof import("../src/models/vendor.model");
const { Product } = require("../src/models/product.model") as typeof import("../src/models/product.model");
const { Review } = require("../src/models/review.model") as typeof import("../src/models/review.model");
const { Cart } = require("../src/models/cart.model") as typeof import("../src/models/cart.model");
const { Notification: NotificationModel } = require("../src/models/notification.model") as typeof import("../src/models/notification.model");

mongoose.set("bufferCommands", false);

let databasesReady = false;
let databaseInitializationError: unknown;

beforeAll(async () => {
  try {
    await connectMongo({ serverSelectionTimeoutMS: 3000 });
    await sql.raw("SELECT 1");
    await sql.migrate.latest();
    databasesReady = true;
  } catch (error) {
    databaseInitializationError = error;
  }
});

beforeEach(async () => {
  if (!databasesReady) {
    const reason = databaseInitializationError instanceof Error
      ? databaseInitializationError.message
      : String(databaseInitializationError);
    throw new Error(`Integration test databases are unavailable. Start them with "npm run test:db:up". ${reason}`);
  }
  await Promise.all([
    User.deleteMany({}),
    LoginAttempt.deleteMany({}),
    Vendor.deleteMany({}),
    Product.deleteMany({}),
    Review.deleteMany({}),
    Cart.deleteMany({}),
    NotificationModel.deleteMany({})
  ]);
  await sql.raw(`
    TRUNCATE TABLE
      disputes, payouts, order_items, sub_orders, orders,
      ledger_entries, transactions, idempotency_records, outbox_events,
      settings, accounts
    RESTART IDENTITY CASCADE
  `);
  await sql("accounts").insert([
    { owner_type: "system", owner_id: "PLATFORM_ESCROW" },
    { owner_type: "system", owner_id: "PLATFORM_REVENUE" },
    { owner_type: "system", owner_id: "PLATFORM_PAYOUT_CLEARING" },
    { owner_type: "system", owner_id: "PLATFORM_FUNDING_SOURCE" },
    { owner_type: "system", owner_id: "EXTERNAL_PAYOUT" }
  ]);
});

afterAll(async () => {
  await Promise.all([closeMongo(), closePostgres()]);
});
