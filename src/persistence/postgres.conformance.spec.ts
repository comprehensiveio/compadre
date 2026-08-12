import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll } from "vitest";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { createDatabase } from "../db/client.js";
import { createPostgresRunStore } from "../durability/postgres.js";
import { createPostgresChatPersistence } from "./postgres.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const suffix = randomUUID().replaceAll("-", "");
const applicationSchema = `compadre_persistence_${suffix}`;
const migrationSchema = `drizzle_${suffix}`;
const adminPool = connectionString ? new pg.Pool({ connectionString }) : undefined;
const pool = connectionString
  ? new pg.Pool({
      connectionString,
      options: `-c search_path=${applicationSchema}`,
    })
  : undefined;
let initialized = false;

async function persistence() {
  if (!pool) {
    throw new Error("Set COMPADRE_TEST_DATABASE_URL to run persistence tests");
  }
  if (!initialized) {
    if (!adminPool) throw new Error("Persistence test admin pool is unavailable");
    await adminPool.query(`CREATE SCHEMA "${applicationSchema}"`);
    const db = createDatabase(pool);
    await migrate(db, { migrationsFolder, migrationsSchema: migrationSchema });
    initialized = true;
  }
  const db = createDatabase(pool);
  return createPostgresChatPersistence(db, createPostgresRunStore(db));
}

runPersistenceConformance("compadre-postgres", persistence, {
  skip: ["generationRuns", "artifacts", "blobs"],
});

afterAll(async () => {
  await pool?.end();
  if (adminPool) {
    await adminPool
      .query(`DROP SCHEMA IF EXISTS "${applicationSchema}" CASCADE`)
      .catch(() => undefined);
    await adminPool
      .query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`)
      .catch(() => undefined);
    await adminPool.end();
  }
});
