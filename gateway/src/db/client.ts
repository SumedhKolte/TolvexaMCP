import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. Production uses node-postgres; the integration tests
 * use PGlite (in-process Postgres) with the same schema and migrations.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema }) as unknown as Db;
}

export { schema };
