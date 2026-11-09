import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { sql } from "../../src/db/postgres";
import { Cart } from "../../src/models/cart.model";
import { Product } from "../../src/models/product.model";
import { User } from "../../src/models/user.model";
import { Vendor } from "../../src/models/vendor.model";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "../../src/services/ledger.service";

export const TEST_PASSWORD = "KoboMarket-Test-Password-123!";
const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 4);

let nextEmail = 0;

export async function createUser(input: {
  email?: string;
  roles?: string[];
  verified?: boolean;
  password?: string;
} = {}) {
  nextEmail += 1;
  const user = await User.create({
    email: input.email ?? `test-user-${nextEmail}@kobomarket.local`,
    passwordHash: input.password ? bcrypt.hashSync(input.password, 4) : passwordHash,
    roles: input.roles ?? ["buyer"],
    ...(input.verified === false ? {} : { emailVerifiedAt: new Date() }),
    status: "active"
  });
  await sql("accounts").insert({ owner_type: "user", owner_id: user.id, currency: "NGN" });
  return user;
}

export async function fundWallet(userId: string, amountKobo: number): Promise<void> {
  await sql.transaction(async (trx) => {
    const source = await systemAccount(trx, "PLATFORM_FUNDING_SOURCE");
    const wallet = await accountForUser(trx, userId, true);
    const transaction = await createTransaction(trx, {
      type: "WALLET_FUNDING",
      status: "succeeded",
      metadata: { userId, amountKobo }
    });
    await postTransfer(trx, {
      transactionId: transaction.id,
      debitAccountId: source,
      creditAccountId: wallet.id,
      amountKobo
    });
  });
}

export async function createApprovedVendor(input: {
  bankAccountNumber?: string;
} = {}) {
  const owner = await createUser({ roles: ["buyer", "vendor"] });
  const vendor = await Vendor.create({
    ownerId: owner.id,
    storeName: `Store ${owner.id}`,
    description: "Approved test store for marketplace integration tests",
    bankDetails: {
      bankCode: "001",
      accountNumber: input.bankAccountNumber ?? "1234567890",
      accountName: "Test Vendor"
    },
    status: "approved"
  });
  return { owner, vendor };
}

export async function createProduct(input: {
  vendorId: string;
  priceKobo?: number;
  stock?: number;
}) {
  return Product.create({
    vendorId: input.vendorId,
    name: "Integration Test Product",
    slug: `integration-test-product-${new mongoose.Types.ObjectId().toString()}`,
    description: "A test product for end-to-end marketplace integration tests",
    priceKobo: input.priceKobo ?? 1000,
    category: "Test",
    images: [],
    stock: input.stock ?? 20,
    variants: [],
    tags: ["test"],
    isActive: true
  });
}

export async function addToCart(userId: string, productId: string, quantity = 1): Promise<void> {
  let cart = await Cart.findOne({ userId });
  if (!cart) cart = new Cart({ userId, items: [] });
  cart.items.push({
    productId: new mongoose.Types.ObjectId(productId),
    quantity,
    priceAtAddKobo: 1
  });
  await cart.save();
}

export async function createMarketplace(input: {
  buyerBalanceKobo?: number;
  priceKobo?: number;
  stock?: number;
  bankAccountNumber?: string;
} = {}) {
  const buyer = await createUser();
  const { owner: vendorOwner, vendor } = await createApprovedVendor({
    bankAccountNumber: input.bankAccountNumber
  });
  const product = await createProduct({
    vendorId: vendor.id,
    priceKobo: input.priceKobo,
    stock: input.stock
  });
  await addToCart(buyer.id, product.id);
  if (input.buyerBalanceKobo) await fundWallet(buyer.id, input.buyerBalanceKobo);
  return { buyer, vendorOwner, vendor, product };
}
