import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sql } from "../db/postgres";
import { config } from "../config";
import { AppError } from "../middleware/errors";
import { User } from "../models/user.model";
import { LoginAttempt } from "../models/login-attempt.model";
import { logger } from "../logger";

const ACCESS_TTL = "15m";
const REFRESH_DAYS = 7;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issueAccessToken(user: { id: string; roles: string[] }): string {
  return jwt.sign({ roles: user.roles }, config.accessSecret, { subject: user.id, expiresIn: ACCESS_TTL });
}

async function addRefreshToken(userId: string, roles: string[]): Promise<string> {
  const token = jwt.sign({ roles }, config.refreshSecret, { subject: userId, expiresIn: `${REFRESH_DAYS}d` });
  await User.updateOne({ _id: userId }, {
    $push: { refreshTokens: { tokenHash: hash(token), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000) } }
  });
  return token;
}

export async function register(email: string, password: string): Promise<{ userId: string; verificationToken: string }> {
  const normalizedEmail = email.toLowerCase();
  if (await User.exists({ email: normalizedEmail })) {
    throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists");
  }
  const verificationToken = randomBytes(32).toString("hex");
  const user = await User.create({
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 12),
    verificationTokenHash: hash(verificationToken),
    verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "provisioning"
  });
  let walletCreated = false;
  try {
    await sql("accounts").insert({ owner_type: "user", owner_id: user.id, currency: "NGN" });
    walletCreated = true;
    await User.updateOne({ _id: user.id }, { $set: { status: "active" } });
  } catch (error) {
    if (walletCreated) {
      try {
        await sql("accounts").where({ owner_type: "user", owner_id: user.id }).del();
      } catch (compensationError) {
        logger.fatal({ err: compensationError, userId: user.id }, "Registration wallet compensation failed");
        throw error;
      }
    }
    try {
      await User.deleteOne({ _id: user.id });
    } catch (compensationError) {
      logger.fatal({ err: compensationError, userId: user.id }, "Registration user compensation failed");
      throw error;
    }
    throw error;
  }
  return { userId: user.id, verificationToken };
}

export async function verifyEmail(token: string): Promise<void> {
  const user = await User.findOne({
    verificationTokenHash: hash(token),
    verificationExpiresAt: { $gt: new Date() }
  });
  if (!user) throw new AppError(400, "INVALID_VERIFICATION_TOKEN", "Verification token is invalid or expired");
  user.emailVerifiedAt = new Date();
  user.verificationTokenHash = undefined;
  user.verificationExpiresAt = undefined;
  await user.save();
}

export async function login(
  email: string,
  password: string,
  clientIp: string
): Promise<{ accessToken: string; refreshToken: string; user: { id: string; email: string; roles: string[] } }> {
  const normalizedEmail = email.toLowerCase();
  const attemptKey = hash(`${normalizedEmail}:${clientIp}`);
  const now = new Date();
  const attempt = await LoginAttempt.findOne({ key: attemptKey });
  if (attempt && now.getTime() - attempt.windowStartedAt.getTime() < 15 * 60 * 1000 && attempt.count >= 5) {
    throw new AppError(429, "LOGIN_RATE_LIMITED", "Too many failed login attempts; try again later");
  }
  const user = await User.findOne({ email: normalizedEmail });
  const validPassword = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!validPassword || !user) {
    if (!attempt || now.getTime() - attempt.windowStartedAt.getTime() >= 15 * 60 * 1000) {
      await LoginAttempt.updateOne(
        { key: attemptKey },
        { $set: { count: 1, windowStartedAt: now } },
        { upsert: true }
      );
    } else {
      await LoginAttempt.updateOne({ key: attemptKey }, { $inc: { count: 1 } });
    }
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  if (!user.emailVerifiedAt) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email before logging in");
  if (user.status === "frozen") throw new AppError(403, "ACCOUNT_FROZEN", "This account is frozen");
  await LoginAttempt.deleteOne({ key: attemptKey });
  const roles = user.roles;
  const refreshToken = await addRefreshToken(user.id, roles);
  return {
    accessToken: issueAccessToken({ id: user.id, roles }),
    refreshToken,
    user: { id: user.id, email: user.email, roles }
  };
}

export async function refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  let claims: jwt.JwtPayload;
  try {
    const verified = jwt.verify(rawToken, config.refreshSecret);
    if (typeof verified === "string" || !verified.sub) throw new Error("Invalid claims");
    claims = verified;
  } catch {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
  }
  const user = await User.findById(claims.sub);
  if (!user) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
  const tokenHash = hash(rawToken);
  const tokenRecord = user.refreshTokens.find((entry) => entry.tokenHash === tokenHash);
  if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.expiresAt <= new Date()) {
    await User.updateOne({ _id: user.id }, { $set: { "refreshTokens.$[].revokedAt": new Date() } });
    throw new AppError(401, "REFRESH_TOKEN_REUSE", "Refresh token reuse detected; all sessions were revoked");
  }

  const rotation = await User.updateOne(
    { _id: user.id, refreshTokens: { $elemMatch: { tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } } } },
    { $set: { "refreshTokens.$.revokedAt": new Date() } }
  );
  if (rotation.modifiedCount !== 1) {
    await User.updateOne({ _id: user.id }, { $set: { "refreshTokens.$[].revokedAt": new Date() } });
    throw new AppError(401, "REFRESH_TOKEN_REUSE", "Refresh token reuse detected; all sessions were revoked");
  }
  const refreshToken = await addRefreshToken(user.id, user.roles);
  return { accessToken: issueAccessToken({ id: user.id, roles: user.roles }), refreshToken };
}

export async function logout(userId: string, rawToken?: string): Promise<void> {
  if (rawToken) {
    await User.updateOne(
      { _id: userId, "refreshTokens.tokenHash": hash(rawToken) },
      { $set: { "refreshTokens.$.revokedAt": new Date() } }
    );
    return;
  }
  await User.updateOne({ _id: userId }, { $set: { "refreshTokens.$[].revokedAt": new Date() } });
}

export async function requestPasswordReset(email: string): Promise<string | undefined> {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return undefined;
  const token = randomBytes(32).toString("hex");
  user.resetTokenHash = hash(token);
  user.resetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();
  return token;
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const user = await User.findOne({ resetTokenHash: hash(token), resetExpiresAt: { $gt: new Date() } });
  if (!user) throw new AppError(400, "INVALID_RESET_TOKEN", "Password reset token is invalid or expired");
  user.passwordHash = await bcrypt.hash(password, 12);
  user.resetTokenHash = undefined;
  user.resetExpiresAt = undefined;
  user.refreshTokens.forEach((session) => { session.revokedAt = new Date(); });
  await user.save();
}
