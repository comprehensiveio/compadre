// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CENTRAL_SQLITE_TABLES } from "../CompadrePersistenceTables.ts";
import { PersistenceBackend, PersistenceReadClient } from "../Services/PersistenceBackend.ts";
import { makePostgresClientLive, runPostgresMigrations } from "./Postgres.ts";
import { makeTestPostgresPersistence } from "../PostgresTest.ts";

const postgresUrl = process.env.COMPADRE_T3_POSTGRES_TEST_URL;

describe.runIf(postgresUrl)("PostgreSQL persistence", () => {
  const PersistenceLive = makeTestPostgresPersistence(postgresUrl!);

  it.effect("creates the full projection and auth schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly tableName: string }>`
        SELECT table_name AS "tableName"
        FROM information_schema.tables
        WHERE table_schema = current_schema()
        ORDER BY table_name
      `;
      const names = new Set(rows.map((row) => row.tableName));
      for (const expected of [
        "auth_pairing_links",
        "auth_sessions",
        "compadre_t3_migrations",
        "orchestration_commit_order",
        "orchestration_command_receipts",
        "orchestration_events",
        "projection_projects",
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_thread_sessions",
        "projection_turns",
      ]) {
        assert.isTrue(names.has(expected), `missing ${expected}`);
      }
      assert.isFalse(names.has("orchestration_lock_keys"));
      const migrations = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM compadre_t3_migrations
        ORDER BY migration_id
      `;
      assert.deepEqual([...migrations], [{ migrationId: 1, name: "compadre_initial" }]);
    }).pipe(Effect.provide(PersistenceLive)),
  );

  it.effect("does not reapply a completed migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{ readonly createdAt: Date }>`
        SELECT created_at AS "createdAt"
        FROM compadre_t3_migrations
        WHERE migration_id = 1
      `;
      yield* runPostgresMigrations;
      const after = yield* sql<{ readonly createdAt: Date }>`
        SELECT created_at AS "createdAt"
        FROM compadre_t3_migrations
        WHERE migration_id = 1
      `;
      assert.deepEqual([...after], [...before]);
    }).pipe(Effect.provide(PersistenceLive)),
  );

  it.effect("supports the SQLite JSON query contract", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly requestId: string | null }>`
        SELECT json_extract('{"requestId":"request-1"}', '$.requestId') AS "requestId"
      `;
      assert.deepEqual([...rows], [{ requestId: "request-1" }]);
    }).pipe(Effect.provide(PersistenceLive)),
  );

  it.effect("locks one orchestration key without blocking another key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const backend = yield* PersistenceBackend;
      const firstLocked = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondLocked = yield* Deferred.make<void>();

      const first = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* backend.lockOrchestrationKeys([{ scope: "thread", key: "lock-thread-a" }]);
            yield* Deferred.succeed(firstLocked, undefined);
            yield* Deferred.await(releaseFirst);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstLocked);

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* backend.lockOrchestrationKeys([{ scope: "thread", key: "lock-thread-b" }]);
          yield* Deferred.succeed(secondLocked, undefined);
        }),
      );
      assert.isTrue(yield* Deferred.isDone(secondLocked));

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
    }).pipe(Effect.provide(PersistenceLive), Effect.scoped),
  );

  it.effect("serializes two transactions that lock the same orchestration key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const backend = yield* PersistenceBackend;
      const firstLocked = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondAttempted = yield* Deferred.make<void>();
      const secondLocked = yield* Deferred.make<void>();

      const first = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* backend.lockOrchestrationKeys([{ scope: "thread", key: "lock-thread-same" }]);
            yield* Deferred.succeed(firstLocked, undefined);
            yield* Deferred.await(releaseFirst);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstLocked);

      const second = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(secondAttempted, undefined);
            yield* backend.lockOrchestrationKeys([{ scope: "thread", key: "lock-thread-same" }]);
            yield* Deferred.succeed(secondLocked, undefined);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(secondAttempted);
      assert.isTrue(Option.isNone(yield* Deferred.poll(secondLocked)));

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Deferred.await(secondLocked);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(PersistenceLive), Effect.scoped),
  );

  it.effect("rolls back an event and projection together", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events WHERE event_id = 'rollback-event'`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'rollback-project'`;
      const result = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO orchestration_events (
                event_id, aggregate_kind, stream_id, stream_version, event_type,
                occurred_at, actor_kind, payload_json, metadata_json
              ) VALUES (
                'rollback-event', 'project', 'rollback-project', 0, 'project.created',
                '2026-09-03T12:00:00.000Z', 'server', '{}', '{}'
              )
            `;
            yield* sql`
              INSERT INTO projection_projects (
                project_id, title, workspace_root, scripts_json, created_at, updated_at
              ) VALUES (
                'rollback-project', 'Rollback', '/tmp/rollback', '[]',
                '2026-09-03T12:00:00.000Z', '2026-09-03T12:00:00.000Z'
              )
            `;
            yield* sql`
              INSERT INTO projection_projects (
                project_id, title, workspace_root, scripts_json, created_at, updated_at
              ) VALUES (
                'rollback-project', 'Duplicate', '/tmp/rollback', '[]',
                '2026-09-03T12:00:00.000Z', '2026-09-03T12:00:00.000Z'
              )
            `;
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(result));
      const rows = yield* sql<{ readonly count: number }>`
        SELECT CAST(COUNT(*) AS INTEGER) AS count
        FROM orchestration_events
        WHERE event_id = 'rollback-event'
      `;
      assert.deepEqual([...rows], [{ count: 0 }]);
      const projects = yield* sql<{ readonly count: number }>`
        SELECT CAST(COUNT(*) AS INTEGER) AS count
        FROM projection_projects
        WHERE project_id = 'rollback-project'
      `;
      assert.deepEqual([...projects], [{ count: 0 }]);
    }).pipe(Effect.provide(PersistenceLive)),
  );
  it.effect("reserves command connections even when every UI read connection is occupied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reads = yield* PersistenceReadClient;
      const release = yield* Deferred.make<void>();
      const started = yield* Effect.all(Array.from({ length: 8 }, () => Deferred.make<void>()));
      const busy = yield* Effect.all(
        started.map((ready) =>
          reads.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(release);
            }),
          ),
        ),
        { concurrency: 8 },
      ).pipe(Effect.forkScoped);
      yield* Effect.all(started.map(Deferred.await), { concurrency: 8 });
      const rows = yield* sql.withTransaction(sql<{ alive: number }>`SELECT 1 AS alive`);
      assert.strictEqual(rows[0]?.alive, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(busy);
    }).pipe(Effect.provide(PersistenceLive), Effect.scoped),
  );

  it.effect("fails closed for a missing database", () => {
    const unavailable = new URL(postgresUrl!);
    unavailable.pathname = "/compadre_missing_database_test";
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    }).pipe(
      Effect.provide(makePostgresClientLive(unavailable.toString())),
      Effect.exit,
      Effect.map((result) => assert.isTrue(Exit.isFailure(result))),
    );
  });
  it.effect(
    "isolates central migrations from populated controller tables in the same database",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const migrations = new URL("../../../../../hosted/compadre/drizzle/", import.meta.url);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL search_path TO public`;
              for (const entry of NodeFS.readdirSync(migrations).sort()) {
                const path = new URL(`${entry}/migration.sql`, migrations);
                if (!NodeFS.existsSync(path)) continue;
                for (const statement of NodeFS.readFileSync(path, "utf8").split(
                  "--> statement-breakpoint",
                )) {
                  if (statement.trim()) yield* sql.unsafe(statement);
                }
              }
              yield* sql`INSERT INTO compadre_ai_metadata (namespace, key, value) VALUES ('shared-test', 'record', '{"value":"controller"}')`;
              yield* sql`SET LOCAL search_path TO compadre_t3`;
              // Rehearse first deployment into a populated controller database.
              // Rolling back the outer transaction restores the original central tables.
              for (const table of [
                ...CENTRAL_SQLITE_TABLES,
                "compadre_t3_migrations",
                "orchestration_commit_order",
                "compadre_t3_attachment_objects",
              ]) {
                yield* sql`DROP TABLE ${sql(table)} CASCADE`;
              }
              assert.strictEqual((yield* runPostgresMigrations).length, 1);
              assert.strictEqual((yield* runPostgresMigrations).length, 0);
              const namespace = yield* sql<{ name: string }>`SELECT current_schema() AS name`;
              assert.strictEqual(namespace[0]?.name, "compadre_t3");
              const rows = yield* sql<{
                value: { value: string };
              }>`SELECT value FROM public.compadre_ai_metadata WHERE namespace = 'shared-test'`;
              assert.deepEqual([...rows], [{ value: { value: "controller" } }]);
              const visibility = yield* sql<{ controller: string | null; central: string | null }>`
              SELECT to_regclass('compadre_ai_metadata')::text AS controller,
                     to_regclass('compadre_t3.orchestration_events')::text AS central
            `;
              assert.isNull(visibility[0]?.controller);
              assert.isNotNull(visibility[0]?.central);
              return yield* Effect.fail("rollback-controller-fixture" as const);
            }),
          )
          .pipe(
            Effect.catch((error) =>
              error === "rollback-controller-fixture" ? Effect.void : Effect.fail(error),
            ),
          );
      }).pipe(Effect.provide(PersistenceLive)),
  );
});
