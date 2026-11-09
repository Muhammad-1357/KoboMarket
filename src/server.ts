import { app } from "./app";
import { config } from "./config";
import { connectMongo, closeMongo } from "./db/mongo";
import { closePostgres, sql } from "./db/postgres";
import cron from "node-cron";
import { logger } from "./logger";
import { completeExpiredSubOrders } from "./services/order.service";
import { processPendingPayouts } from "./services/payout.service";
import { drainOutbox } from "./workers/outbox.worker";

async function start(): Promise<void> {
  await connectMongo();
  await sql.raw("SELECT 1");
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "KoboMarket API listening");
  });
  const jobs = [
    cron.schedule("* * * * *", () => {
      void completeExpiredSubOrders().catch((error: unknown) => logger.error({ err: error }, "Escrow auto-completion failed"));
      void processPendingPayouts().catch((error: unknown) => logger.error({ err: error }, "Payout processing failed"));
    })
  ];
  let drainingOutbox = false;
  const outboxTimer = setInterval(() => {
    if (drainingOutbox) return;
    drainingOutbox = true;
    void drainOutbox().catch((error: unknown) => logger.error({ err: error }, "Outbox processing failed"))
      .finally(() => { drainingOutbox = false; });
  }, 2000);

  const shutdown = async (): Promise<void> => {
    clearInterval(outboxTimer);
    jobs.forEach((job) => job.stop());
    server.close(async () => {
      await Promise.all([closeMongo(), closePostgres()]);
      process.exit(0);
    });
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start API");
  process.exitCode = 1;
});
