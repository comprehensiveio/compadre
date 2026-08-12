import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDatabase } from "./client.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const LEGACY_DURABILITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS compadre_ai_runs (
  run_id text PRIMARY KEY,
  thread_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'interrupted', 'completed', 'failed', 'aborted')
  ),
  started_at_ms bigint NOT NULL,
  finished_at_ms bigint,
  error jsonb,
  usage jsonb,
  sandbox_key text,
  detached_since_ms bigint,
  cancel_requested boolean,
  driver_epoch bigint
);

CREATE INDEX IF NOT EXISTS compadre_ai_runs_thread_started_idx
  ON compadre_ai_runs (thread_id, started_at_ms);

CREATE INDEX IF NOT EXISTS compadre_ai_runs_reclaimable_idx
  ON compadre_ai_runs (detached_since_ms)
  WHERE status = 'running' AND detached_since_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS compadre_ai_streams (
  run_id text PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1,
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS compadre_ai_stream_events (
  run_id text NOT NULL REFERENCES compadre_ai_streams(run_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  chunk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence)
);
`;

const LEGACY_PR_WATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS compadre_pr_watches (
  id uuid PRIMARY KEY,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  pr_url text NOT NULL,
  slack_team_id text NOT NULL,
  slack_channel_id text NOT NULL,
  slack_thread_ts text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (
    status IN ('waiting', 'delivering', 'notified', 'closed_unmerged')
  ),
  matched_prod_commit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  delivery_started_at timestamptz,
  notified_at timestamptz,
  last_error text,
  UNIQUE (pr_number, slack_team_id, slack_channel_id, slack_thread_ts)
);

CREATE INDEX IF NOT EXISTS compadre_pr_watches_waiting_idx
  ON compadre_pr_watches (created_at)
  WHERE status = 'waiting';
`;

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
    let client: pg.PoolClient | undefined;
    const suffix = randomUUID().replaceAll("-", "");
    const applicationSchema = `compadre_migration_${suffix}`;
    const migrationSchema = `drizzle_${suffix}`;
    try {
      client = await pool.connect();
      await client.query(`CREATE SCHEMA "${applicationSchema}"`);
      await client.query(`SET search_path TO "${applicationSchema}"`);
      await client.query(LEGACY_DURABILITY_SCHEMA);
      await client.query(LEGACY_PR_WATCH_SCHEMA);

      const db = createDatabase(client);
      const migrationConfig = { migrationsFolder, migrationsSchema: migrationSchema };
      await migrate(db, migrationConfig);
      await migrate(db, migrationConfig);

      const applied = await client.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM "${migrationSchema}".__drizzle_migrations`,
      );
      assert.equal(Number(applied.rows[0]?.count), 1);
    } finally {
      if (client) {
        await client.query("RESET search_path").catch(() => undefined);
        await client
          .query(`DROP SCHEMA IF EXISTS "${applicationSchema}" CASCADE`)
          .catch(() => undefined);
        await client
          .query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`)
          .catch(() => undefined);
        client.release();
      }
      await pool.end();
    }
  },
);
