import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDatabase } from "../db/client.js";
import { TriggeredPromptStore } from "./store.js";
import { triggeredPromptInputSchema } from "./types.js";

const connectionString = process.env.COMPADRE_TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

test(
  "TriggeredPromptStore persists definitions and fire results",
  { skip: connectionString ? false : "set COMPADRE_TEST_DATABASE_URL" },
  async () => {
    assert.ok(connectionString);
    const pool = new pg.Pool({ connectionString });
    let client: pg.PoolClient | undefined;
    const suffix = randomUUID().replaceAll("-", "");
    const applicationSchema = `compadre_triggers_${suffix}`;
    try {
      client = await pool.connect();
      await client.query(`CREATE SCHEMA "${applicationSchema}"`);
      await client.query(`SET search_path TO "${applicationSchema}"`);
      const db = createDatabase(client);
      await migrate(db, {
        migrationsFolder,
        migrationsSchema: `drizzle_${suffix}`,
      });

      const store = new TriggeredPromptStore(db);
      const created = await store.create(
        triggeredPromptInputSchema.parse({
          name: "Daily summary",
          prompt: "Summarize the day",
          cronExpression: "0 9 * * *",
          timezone: "America/Chicago",
          slackChannelId: "C0123456789",
          createdBy: "user-1",
        }),
      );
      assert.equal(created.enabled, true);
      assert.deepEqual(created.triggerConfig, {
        cronExpression: "0 9 * * *",
        timezone: "America/Chicago",
      });

      const fetched = await store.get(created.id);
      assert.deepEqual(fetched, created);
      assert.equal((await store.list()).length, 1);

      const updated = await store.update(
        created.id,
        triggeredPromptInputSchema.parse({
          name: "Hourly check",
          prompt: "Check in",
          cronExpression: "@hourly",
          deliveryMode: "existing_thread",
          targetThreadId: "6f76f496-6f37-4c4c-9e2f-000000000000",
        }),
      );
      assert.equal(updated?.name, "Hourly check");
      assert.equal(updated?.deliveryMode, "existing_thread");
      assert.equal(updated?.slackChannelId, undefined);
      assert.equal(updated?.createdBy, "user-1");

      const paused = await store.setEnabled(created.id, false);
      assert.equal(paused?.enabled, false);

      await store.recordFired(created.id, { centralThreadId: "thread-9" });
      const fired = await store.get(created.id);
      assert.equal(fired?.lastCentralThreadId, "thread-9");
      assert.ok(fired?.lastFiredAt);

      assert.equal(await store.delete(created.id), true);
      assert.equal(await store.delete(created.id), false);
      assert.equal(await store.get(created.id), null);
    } finally {
      if (client) {
        await client.query("RESET search_path").catch(() => undefined);
        await client
          .query(`DROP SCHEMA IF EXISTS "${applicationSchema}" CASCADE`)
          .catch(() => undefined);
        await client
          .query(`DROP SCHEMA IF EXISTS "drizzle_${suffix}" CASCADE`)
          .catch(() => undefined);
        client.release();
      }
      await pool.end();
    }
  },
);
