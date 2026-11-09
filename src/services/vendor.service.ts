import { sql } from "../db/postgres";
import { AppError } from "../middleware/errors";
import { User } from "../models/user.model";
import { Vendor } from "../models/vendor.model";

export async function applyForVendor(
  ownerId: string,
  input: { storeName: string; description: string; bankDetails: { bankCode: string; accountNumber: string; accountName: string } }
) {
  if (await Vendor.exists({ ownerId })) throw new AppError(409, "APPLICATION_EXISTS", "A vendor application already exists");
  return Vendor.create({ ownerId, ...input, status: "pending" });
}

export async function approveVendor(vendorId: string, approve: boolean): Promise<void> {
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) throw new AppError(404, "VENDOR_NOT_FOUND", "Vendor not found");
  if (vendor.status !== "pending") throw new AppError(409, "INVALID_VENDOR_STATE", "Only pending applications can be reviewed");
  vendor.status = approve ? "approved" : "rejected";
  await vendor.save();
  if (approve) {
    const user = await User.findById(vendor.ownerId);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Vendor account not found");
    if (!user.roles.includes("vendor")) {
      user.roles.push("vendor");
      await user.save();
    }
    await sql("accounts").where({ owner_type: "user", owner_id: vendor.ownerId }).update({ status: "active" });
  }
}
