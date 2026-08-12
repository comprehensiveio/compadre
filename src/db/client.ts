import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";

const relations = defineRelations(schema);

/** Add typed Drizzle queries to an existing pool without changing ownership. */
export function createDatabase(client: pg.Pool | pg.PoolClient) {
  return drizzle({ client, relations });
}

export type CompadreDatabase = ReturnType<typeof createDatabase>;
