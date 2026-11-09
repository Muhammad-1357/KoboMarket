import mongoose, { type ConnectOptions } from "mongoose";
import { config } from "../config";

export async function connectMongo(options?: ConnectOptions): Promise<void> {
  await mongoose.connect(config.mongoUri, options);
}

export async function closeMongo(): Promise<void> {
  await mongoose.disconnect();
}
