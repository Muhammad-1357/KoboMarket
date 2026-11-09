import knex, { type Knex } from "knex";
import knexConfig from "../../knexfile";

export const sql: Knex = knex(knexConfig);

export async function closePostgres(): Promise<void> {
  await sql.destroy();
}
