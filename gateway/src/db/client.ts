import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. Production uses node-postgres; the integration tests
 * use PGlite (in-process Postgres) with the same schema and migrations.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createPool(databaseUrl: string, onError?: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // When Postgres restarts, node-postgres emits "error" on the pool for every idle client.
  // An EventEmitter "error" with no listener throws and kills the process, so a database
  // restart would crash the gateway. With a listener, the dead clients are dropped and the
  // next query opens a fresh connection; /readyz reports not-ready meanwhile.
  pool.on("error", (err) => onError?.(err));
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema }) as unknown as Db;
}

export { schema };
