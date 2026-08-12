import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

/** Add typed Drizzle queries to an existing pool without changing ownership. */
export function createDatabase(pool: pg.Pool) {
  return drizzle({ client: pool });
}

export type CompadreDatabase = ReturnType<typeof createDatabase>;
