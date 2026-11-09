import request from "supertest";
import { app } from "../../src/app";
import { sql } from "../../src/db/postgres";
import { User } from "../../src/models/user.model";
import { Product } from "../../src/models/product.model";
import { Cart } from "../../src/models/cart.model";
import { login, refresh } from "../../src/services/auth.service";
import { openDispute, resolveDispute } from "../../src/services/dispute.service";
import { completeExpiredSubOrders, checkout, confirmDelivery, shipSubOrder } from "../../src/services/order.service";
import { processPendingPayouts, requestPayout } from "../../src/services/payout.service";
import { getWallet, initializeFunding, signMockWebhook } from "../../src/services/wallet.service";
import {
  addToCart,
  createApprovedVendor,
  createMarketplace,
  createProduct,
  createUser,
  fundWallet,
  TEST_PASSWORD
} from "../helpers/fixtures";

describe("KoboMarket required integration tests", () => {
  test("a user cannot log in before verifying email", async () => {
    const user = await createUser({ verified: false });

    await expect(login(user.email, TEST_PASSWORD, "127.0.0.10"))
      .rejects.toMatchObject({ status: 403, code: "EMAIL_NOT_VERIFIED" });
  });

  test("reusing a rotated refresh token revokes all sessions", async () => {
    const user = await createUser();
    const firstSession = await login(user.email, TEST_PASSWORD, "127.0.0.11");
    const secondSession = await login(user.email, TEST_PASSWORD, "127.0.0.11");
    const rotated = await refresh(firstSession.refreshToken);

    await expect(refresh(firstSession.refreshToken))
      .rejects.toMatchObject({ status: 401, code: "REFRESH_TOKEN_REUSE" });
    await expect(refresh(secondSession.refreshToken))
      .rejects.toMatchObject({ status: 401, code: "REFRESH_TOKEN_REUSE" });
    await expect(refresh(rotated.refreshToken))
      .rejects.toMatchObject({ status: 401, code: "REFRESH_TOKEN_REUSE" });

    const stored = await User.findById(user.id).lean();
    expect(stored?.refreshTokens.every((token) => token.revokedAt)).toBe(true);
  });

  test("a buyer cannot access vendor or admin routes", async () => {
    const user = await createUser();
    const session = await login(user.email, TEST_PASSWORD, "127.0.0.12");

    const adminResponse = await request(app)
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${session.accessToken}`);
    const vendorResponse = await request(app)
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({});

    expect(adminResponse.status).toBe(403);
    expect(vendorResponse.status).toBe(403);
  });

  test("the canonical Paystack webhook credits once when delivered twice", async () => {
    const user = await createUser();
    const amountKobo = 45000;
    const funding = await initializeFunding(user.id, amountKobo, "webhook-replay-key");
    const payload = {
      event: "charge.success",
      data: { reference: funding.reference, amountKobo }
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = signMockWebhook(rawBody);

    const first = await request(app)
      .post("/api/v1/webhooks/paystack")
      .set("x-paystack-signature", signature)
      .set("Content-Type", "application/json")
      .send(rawBody.toString("utf8"));
    const duplicate = await request(app)
      .post("/api/v1/webhooks/paystack")
      .set("x-paystack-signature", signature)
      .set("Content-Type", "application/json")
      .send(rawBody.toString("utf8"));

    expect(first.status).toBe(200);
    expect(first.body.data.credited).toBe(true);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.credited).toBe(false);
    expect((await getWallet(user.id)).balanceKobo).toBe(amountKobo);
    expect(await sql("ledger_entries").count({ count: "*" }).first()).toMatchObject({ count: "2" });
  });

  test("a webhook with an invalid signature is rejected without crediting", async () => {
    const user = await createUser();
    const amountKobo = 35000;
    const funding = await initializeFunding(user.id, amountKobo, "invalid-webhook-key");
    const rawBody = Buffer.from(JSON.stringify({
      event: "charge.success",
      data: { reference: funding.reference, amountKobo }
    }));

    const response = await request(app)
      .post("/api/v1/webhooks/paystack")
      .set("x-paystack-signature", "00".repeat(64))
      .set("Content-Type", "application/json")
      .send(rawBody.toString("utf8"));

    expect(response.status).toBe(401);
    expect((await getWallet(user.id)).balanceKobo).toBe(0);
    expect(await sql("ledger_entries").count({ count: "*" }).first()).toMatchObject({ count: "0" });
  });

  test("insufficient checkout balance creates no order or ledger entries", async () => {
    const { buyer, product } = await createMarketplace({ priceKobo: 1000, stock: 5 });

    await expect(checkout(buyer.id, "insufficient-balance-key"))
      .rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_FUNDS" });

    expect(await sql("orders").count({ count: "*" }).first()).toMatchObject({ count: "0" });
    expect(await sql("ledger_entries").count({ count: "*" }).first()).toMatchObject({ count: "0" });
    expect((await Product.findById(product.id))?.stock).toBe(5);
  });

  test("ten concurrent checkouts spend a wallet that can afford exactly three orders", async () => {
    const { buyer, product } = await createMarketplace({
      buyerBalanceKobo: 3000,
      priceKobo: 1000,
      stock: 20
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => checkout(buyer.id, `concurrent-checkout-${index}`))
    );
    const succeeded = results.filter((result) => result.status === "fulfilled");

    expect(succeeded).toHaveLength(3);
    expect(await sql("orders").count({ count: "*" }).first()).toMatchObject({ count: "3" });
    expect((await getWallet(buyer.id)).balanceKobo).toBe(0);
    expect((await Product.findById(product.id))?.stock).toBe(17);
  });

  test("two buyers racing for the last stock unit result in one successful checkout", async () => {
    const firstBuyer = await createUser();
    const secondBuyer = await createUser();
    await fundWallet(firstBuyer.id, 1000);
    await fundWallet(secondBuyer.id, 1000);
    const { vendor } = await createApprovedVendor();
    const product = await createProduct({ vendorId: vendor.id, priceKobo: 1000, stock: 1 });
    await Promise.all([
      addToCart(firstBuyer.id, product.id),
      addToCart(secondBuyer.id, product.id)
    ]);

    const results = await Promise.allSettled([
      checkout(firstBuyer.id, "last-stock-buyer-one"),
      checkout(secondBuyer.id, "last-stock-buyer-two")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await sql("orders").count({ count: "*" }).first()).toMatchObject({ count: "1" });
    expect((await Product.findById(product.id))?.stock).toBe(0);
  });

  test("repeating checkout with the same idempotency key creates one order", async () => {
    const { buyer } = await createMarketplace({ buyerBalanceKobo: 5000, priceKobo: 1000, stock: 5 });

    const first = await checkout(buyer.id, "same-checkout-key");
    await Cart.deleteOne({ userId: buyer.id });
    const replay = await checkout(buyer.id, "same-checkout-key");

    expect(replay).toEqual(first);
    expect(await sql("orders").count({ count: "*" }).first()).toMatchObject({ count: "1" });
  });

  test("reusing a checkout idempotency key with a different cart body conflicts", async () => {
    const { buyer, product } = await createMarketplace({ buyerBalanceKobo: 5000, priceKobo: 1000, stock: 5 });
    await checkout(buyer.id, "changed-checkout-key");
    await addToCart(buyer.id, product.id);

    await expect(checkout(buyer.id, "changed-checkout-key"))
      .rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(await sql("orders").count({ count: "*" }).first()).toMatchObject({ count: "1" });
  });

  test("the database rejects an invalid PAID to COMPLETED transition", async () => {
    const { buyer, vendorOwner } = await createMarketplace({
      buyerBalanceKobo: 5000,
      priceKobo: 1000,
      stock: 5
    });
    const order = await checkout(buyer.id, "invalid-transition-key");
    const subOrder = await sql("sub_orders").where({ order_id: order.orderId }).first();

    await expect(
      sql("sub_orders").where({ id: subOrder.id }).update({ status: "COMPLETED" })
    ).rejects.toThrow(/invalid sub-order state transition/i);
    expect((await sql("sub_orders").where({ id: subOrder.id }).first()).status).toBe("PAID");
    expect(vendorOwner).toBeDefined();
  });

  test("completing an order splits escrow into vendor proceeds and platform commission", async () => {
    const { buyer, vendorOwner } = await createMarketplace({
      buyerBalanceKobo: 10000,
      priceKobo: 10000,
      stock: 5
    });
    const order = await checkout(buyer.id, "escrow-release-key");
    const subOrder = await sql("sub_orders").where({ order_id: order.orderId }).first();

    expect(subOrder.vendor_id).toBe(vendorOwner.id);
    await shipSubOrder(vendorOwner.id, subOrder.id);
    await confirmDelivery(buyer.id, subOrder.id);

    expect((await getWallet(buyer.id)).balanceKobo).toBe(0);
    expect((await getWallet(vendorOwner.id)).balanceKobo).toBe(9500);
    const revenue = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_REVENUE" }).first("balance_kobo");
    const escrow = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_ESCROW" }).first("balance_kobo");
    expect(Number(revenue.balance_kobo)).toBe(500);
    expect(Number(escrow.balance_kobo)).toBe(0);
    expect((await sql("sub_orders").where({ id: subOrder.id }).first()).status).toBe("COMPLETED");
  });

  test("an open dispute prevents an expired shipment from auto-completing", async () => {
    const { buyer, vendorOwner } = await createMarketplace({
      buyerBalanceKobo: 10000,
      priceKobo: 10000,
      stock: 5
    });
    const order = await checkout(buyer.id, "disputed-timeout-key");
    const subOrder = await sql("sub_orders").where({ order_id: order.orderId }).first();
    await shipSubOrder(vendorOwner.id, subOrder.id);
    await sql("sub_orders").where({ id: subOrder.id }).update({
      shipped_at: sql.raw("NOW() - INTERVAL '73 hours'")
    });
    await openDispute(buyer.id, subOrder.id, "Order is not as described", []);

    expect(await completeExpiredSubOrders()).toBe(0);
    expect((await sql("sub_orders").where({ id: subOrder.id }).first()).status).toBe("DISPUTED");
    const escrow = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_ESCROW" }).first("balance_kobo");
    expect(Number(escrow.balance_kobo)).toBe(10000);
  });

  test("a partial refund preserves balanced ledger entries and reconciled account balances", async () => {
    const { buyer, vendorOwner } = await createMarketplace({
      buyerBalanceKobo: 10000,
      priceKobo: 10000,
      stock: 5
    });
    const order = await checkout(buyer.id, "partial-refund-key");
    const subOrder = await sql("sub_orders").where({ order_id: order.orderId }).first();
    await shipSubOrder(vendorOwner.id, subOrder.id);
    const dispute = await openDispute(buyer.id, subOrder.id, "Partial refund requested", []);

    await resolveDispute(dispute.id, "test-admin-id", "partial_refund", "Refunding part of the order", 3000);

    expect((await getWallet(buyer.id)).balanceKobo).toBe(3000);
    expect((await getWallet(vendorOwner.id)).balanceKobo).toBe(6650);
    const revenue = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_REVENUE" }).first("balance_kobo");
    expect(Number(revenue.balance_kobo)).toBe(350);

    const unbalanced = await sql.raw(`
      SELECT t.id
      FROM transactions t
      JOIN ledger_entries le ON le.transaction_id = t.id
      GROUP BY t.id
      HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount_kobo ELSE 0 END)
        <> SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE 0 END)
    `);
    const mismatched = await sql.raw(`
      SELECT a.id
      FROM accounts a
      LEFT JOIN ledger_entries le ON le.account_id = a.id
      GROUP BY a.id
      HAVING a.balance_kobo::numeric
        <> COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_kobo ELSE -le.amount_kobo END), 0)::numeric
    `);
    expect(unbalanced.rows).toHaveLength(0);
    expect(mismatched.rows).toHaveLength(0);
  });

  test("a failed payout reverses the clearing transfer back to the vendor wallet", async () => {
    const { owner } = await createApprovedVendor({ bankAccountNumber: "1234560000" });
    await fundWallet(owner.id, 150000);
    const payout = await requestPayout(owner.id, 100000, "failed-payout-key");

    expect((await getWallet(owner.id)).balanceKobo).toBe(50000);
    expect(await processPendingPayouts()).toBe(1);

    const storedPayout = await sql("payouts").where({ id: payout.id }).first();
    expect(storedPayout.status).toBe("FAILED");
    expect((await getWallet(owner.id)).balanceKobo).toBe(150000);
    const clearing = await sql("accounts").where({ owner_type: "system", owner_id: "PLATFORM_PAYOUT_CLEARING" }).first("balance_kobo");
    expect(Number(clearing.balance_kobo)).toBe(0);
  });

  test("simultaneous payout requests cannot withdraw more than the wallet balance", async () => {
    const { owner } = await createApprovedVendor();
    await fundWallet(owner.id, 150000);

    const results = await Promise.allSettled([
      requestPayout(owner.id, 100000, "concurrent-payout-one"),
      requestPayout(owner.id, 100000, "concurrent-payout-two")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getWallet(owner.id)).balanceKobo).toBe(50000);
    expect(await sql("payouts").where({ vendor_id: owner.id, status: "PENDING" }).count({ count: "*" }).first()).toMatchObject({ count: "1" });
  });
});
