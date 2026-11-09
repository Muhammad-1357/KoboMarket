import bcrypt from "bcryptjs";
import { closeMongo, connectMongo } from "../db/mongo";
import { closePostgres, sql } from "../db/postgres";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { Vendor } from "../models/vendor.model";
import { accountForUser, createTransaction, postTransfer, systemAccount } from "../services/ledger.service";

async function createUser(email: string, roles: string[], passwordHash: string): Promise<string> {
  const user = await User.findOneAndUpdate(
    { email },
    { $setOnInsert: { email, passwordHash, roles, emailVerifiedAt: new Date(), status: "active" } },
    { upsert: true, new: true }
  );
  await sql("accounts").insert({ owner_type: "user", owner_id: user.id, currency: "NGN" }).onConflict(["owner_type", "owner_id", "currency"]).ignore();
  return user.id;
}

async function seed(): Promise<void> {
  const seedPassword = process.env.SEED_PASSWORD;
  if (!seedPassword || seedPassword.length < 12) throw new Error("Set SEED_PASSWORD (at least 12 characters) before seeding");
  await connectMongo();
  const passwordHash = await bcrypt.hash(seedPassword, 12);
  const adminId = await createUser("admin@kobomarket.local", ["admin"], passwordHash);
  const vendorIds: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const ownerId = await createUser(`vendor${index}@kobomarket.local`, ["buyer", "vendor"], passwordHash);
    vendorIds.push(ownerId);
    await Vendor.updateOne(
      { ownerId },
      { $setOnInsert: {
        ownerId,
        storeName: `Kobo Store ${index}`,
        description: `Seed vendor store ${index}`,
        bankDetails: { bankCode: "001", accountNumber: `12345678${index}00`, accountName: `Kobo Vendor ${index}` },
        status: "approved"
      } },
      { upsert: true }
    );
    await User.updateOne({ _id: ownerId }, { $addToSet: { roles: "vendor" } });
  }
  for (let index = 1; index <= 20; index += 1) {
    const vendorId = vendorIds[(index - 1) % vendorIds.length];
    await Product.updateOne(
      { slug: `seed-product-${index}` },
      { $setOnInsert: {
        vendorId,
        name: `Seed Product ${index}`,
        slug: `seed-product-${index}`,
        description: `Sample marketplace product ${index}`,
        priceKobo: 15000 + index * 100,
        category: index % 2 ? "Home" : "Fashion",
        images: [],
        stock: 25,
        variants: [],
        tags: ["seed"],
        isActive: true
      } },
      { upsert: true }
    );
  }
  const fundingSource = await sql.transaction((trx) => systemAccount(trx, "PLATFORM_FUNDING_SOURCE"));
  for (let index = 1; index <= 5; index += 1) {
    const buyerId = await createUser(`buyer${index}@kobomarket.local`, ["buyer"], passwordHash);
    await sql.transaction(async (trx) => {
      const wallet = await accountForUser(trx, buyerId, true);
      if (wallet.balance > 0) return;
      const transaction = await createTransaction(trx, {
        type: "WALLET_FUNDING",
        status: "succeeded",
        metadata: { userId: buyerId, amountKobo: 500000 }
      });
      await postTransfer(trx, {
        transactionId: transaction.id,
        debitAccountId: fundingSource,
        creditAccountId: wallet.id,
        amountKobo: 500000
      });
    });
  }
  console.log(`Seed complete. Admin: admin@kobomarket.local; seeded users share SEED_PASSWORD. Admin user id: ${adminId}`);
}

seed().catch((error: unknown) => {
  console.error("Seed failed", error);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.allSettled([closeMongo(), closePostgres()]);
});
