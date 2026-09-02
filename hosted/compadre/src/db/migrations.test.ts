import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDatabase } from "./client.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

test(
  "Drizzle creates the application schema idempotently",
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

      const db = createDatabase(client);
      const migrationConfig = {
        migrationsFolder,
        migrationsSchema: migrationSchema,
      };
      await migrate(db, migrationConfig);
      const firstApplied = await client.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM "${migrationSchema}".__drizzle_migrations`,
      );
      await migrate(db, migrationConfig);

      const applied = await client.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM "${migrationSchema}".__drizzle_migrations`,
      );
      const firstCount = Number(firstApplied.rows[0]?.count);
      assert.ok(firstCount > 0);
      assert.equal(Number(applied.rows[0]?.count), firstCount);

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [applicationSchema],
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [
          "compadre_ai_interrupts",
          "compadre_ai_metadata",
          "compadre_ai_runs",
          "compadre_ai_stream_events",
          "compadre_ai_streams",
          "compadre_ai_threads",
          "compadre_auth_login_flows",
          "compadre_auth_login_grants",
          "compadre_pr_watches",
          "compadre_slack_inbox_events",
          "compadre_slack_turn_deliveries",
          "compadre_user_identities",
          "compadre_users",
        ],
      );
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
