import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, test } from "vitest";
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
let setup: Promise<void> | undefined;

async function persistence() {
  if (!pool) {
    throw new Error("Set COMPADRE_TEST_DATABASE_URL to run persistence tests");
  }
  setup ??= (async () => {
    if (!adminPool) throw new Error("Persistence test admin pool is unavailable");
    // UUID-derived schema names contain only a fixed prefix and hex. Postgres
    // cannot bind identifiers, so interpolation here is intentional and safe.
    await adminPool.query(`CREATE SCHEMA "${applicationSchema}"`);
    await migrate(createDatabase(pool), {
      migrationsFolder,
      migrationsSchema: migrationSchema,
    });
  })();
  await setup;
  const db = createDatabase(pool);
  return createPostgresChatPersistence(db, createPostgresRunStore(db));
}

if (connectionString) {
  runPersistenceConformance("compadre-postgres", persistence, {
    skip: ["generationRuns", "artifacts", "blobs"],
  });
} else {
  test.skip("compadre-postgres requires COMPADRE_TEST_DATABASE_URL", () => {});
}

afterAll(async () => {
  await pool?.end();
  if (adminPool) {
    // These identifiers are the same internal UUID-derived names described
    // above; PostgreSQL DDL identifiers cannot be supplied as bind parameters.
    try {
      await Promise.all([
        adminPool.query(
          `DROP SCHEMA IF EXISTS "${applicationSchema}" CASCADE`,
        ),
        adminPool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`),
      ]);
    } finally {
      await adminPool.end();
    }
  }
});
