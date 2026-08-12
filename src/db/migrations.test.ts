import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { POSTGRES_DURABILITY_SCHEMA } from "../durability/postgres-schema.js";
import { PR_WATCH_SCHEMA } from "../services/pr-watch.js";
import { createDatabase } from "./client.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

test("the Drizzle baseline is safe for tables created by legacy startup DDL", async () => {
  const baseline = await readFile(
    new URL(
      "../../drizzle/20260812132401_baseline/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const table of [
    "compadre_ai_runs",
    "compadre_ai_streams",
    "compadre_ai_stream_events",
    "compadre_pr_watches",
  ]) {
    assert.match(baseline, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
  }
  assert.doesNotMatch(baseline, /CREATE TABLE (?!IF NOT EXISTS)/);
  assert.doesNotMatch(baseline, /CREATE INDEX (?!IF NOT EXISTS)/);
  assert.match(baseline, /ADD COLUMN IF NOT EXISTS "delivery_started_at"/);
});

test(
  "Drizzle adopts a database initialized by the legacy bootstrap",
  { skip: connectionString ? false : "set COMPADRE_TEST_DATABASE_URL" },
  async () => {
    assert.ok(connectionString);
    const pool = new pg.Pool({ connectionString });
    try {
      await pool.query(POSTGRES_DURABILITY_SCHEMA);
      await pool.query(PR_WATCH_SCHEMA);

      const db = createDatabase(pool);
      await migrate(db, { migrationsFolder });
      await migrate(db, { migrationsFolder });

      const applied = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM drizzle.__drizzle_migrations`,
      );
      assert.equal(Number(applied.rows[0]?.count), 1);
    } finally {
      await pool.end();
    }
  },
);
