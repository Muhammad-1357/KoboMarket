import type { Knex } from "knex";
import { config } from "./src/config";

const knexConfig: Knex.Config = {
  client: "pg",
  connection: config.databaseUrl,
  migrations: { directory: "./migrations", extension: "ts", loadExtensions: [".ts"] }
};

export default knexConfig;
