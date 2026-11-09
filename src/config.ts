import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  WEBHOOK_SECRET: z.string().min(16),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:5173"),
  COMMISSION_BPS: z.coerce.number().int().min(0).max(10000).default(500),
  ESCROW_TIMEOUT_HOURS: z.coerce.number().int().positive().default(72),
  PAYOUT_MINIMUM_KOBO: z.coerce.number().int().positive().default(100000),
  MOCK_PROVIDER_SECRET: z.string().min(16).default("local-only-secret")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  mongoUri: parsed.data.MONGODB_URI,
  databaseUrl: parsed.data.DATABASE_URL,
  accessSecret: parsed.data.JWT_ACCESS_SECRET,
  refreshSecret: parsed.data.JWT_REFRESH_SECRET,
  webhookSecret: parsed.data.WEBHOOK_SECRET,
  frontendOrigin: parsed.data.FRONTEND_ORIGIN,
  commissionBps: parsed.data.COMMISSION_BPS,
  escrowTimeoutHours: parsed.data.ESCROW_TIMEOUT_HOURS,
  payoutMinimumKobo: parsed.data.PAYOUT_MINIMUM_KOBO,
  mockProviderSecret: parsed.data.MOCK_PROVIDER_SECRET
};
