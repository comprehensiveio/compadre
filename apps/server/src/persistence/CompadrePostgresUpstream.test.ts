import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migration001Initial } from "./CompadrePostgresSchema.ts";
import { migration003Upstream } from "./CompadrePostgresUpstream.ts";
import nativeStreams from "./Migrations/045_NativeThreadStreams.ts";
import { runMigrations } from "./Migrations.ts";
import { makeTestPostgresPersistence } from "./PostgresTest.ts";

const verifyUpgrade = (backend: "sqlite" | "postgres") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (backend === "postgres") {
          yield* sql`CREATE SCHEMA compadre_upgrade_fixture`;
          yield* sql`SET LOCAL search_path = compadre_upgrade_fixture`;
          yield* migration001Initial;
          yield* nativeStreams;
          yield* sql`CREATE TABLE compadre_t3_schema_compatibility (
          singleton_id INTEGER PRIMARY KEY, schema_version INTEGER, minimum_app_schema_version INTEGER
        )`;
          yield* sql`INSERT INTO compadre_t3_schema_compatibility VALUES (1, 2, 1)`;
        } else {
          yield* runMigrations({ toMigrationInclusive: 45 });
        }

        const model = '{"instanceId":"codex","model":"example-model"}';
        const createdAt = "2026-01-01T00:00:00.000Z";
        const sweptAt = "2026-02-01T00:00:00.000Z";
        for (const project of ["seeded", "configured"]) {
          yield* sql`INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, default_model_selection_json
        ) VALUES (${project}, ${project}, ${"/" + project}, '[]', ${createdAt}, ${createdAt}, ${model})`;
          yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (${project}, 'project', ${project}, 0, 'project.created', ${createdAt}, 'client',
          ${'{"defaultModelSelection":' + model + "}"}, '{}')`;
        }
        yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES ('configured-model', 'project', 'configured', 1, 'project.meta-updated', ${createdAt}, 'client',
        ${'{"defaultModelSelection":' + model + "}"}, '{}')`;
        for (const thread of ["automatic", "manual", "empty"]) {
          yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, settled_override, settled_at,
          linked_pull_request_json, started_by_user_id, participants_json
        ) VALUES (${thread}, 'configured', ${thread}, ${createdAt}, ${sweptAt}, 'settled', ${sweptAt},
          '{"repository":"comprehensiveio/compadre","number":57,"url":"https://github.com/comprehensiveio/compadre/pull/57"}',
          'canonical-user', '["canonical-user"]')`;
          yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json
        ) VALUES (${thread}, 'thread', ${thread}, 0, 'thread.settled', ${sweptAt},
          ${thread === "manual" ? "manual-settle" : "server:auto-settle:" + thread},
          ${thread === "manual" ? "client" : "server"}, ${'{"settledAt":"' + sweptAt + '"}'}, '{}')`;
        }
        for (const [id, at] of [
          ["good", "2026-01-15T12:00:00.000Z"],
          ["bad", "invalid"],
          ["later", "2026-03-01T00:00:00.000Z"],
        ]) {
          yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attribution_json
        ) VALUES (${id}, 'automatic', 'user', 'kept', 0, ${at}, ${at}, '{"userId":"canonical-user"}')`;
        }
        yield* sql`INSERT INTO native_thread_streams VALUES ('automatic', 'worker-thread', 7, 42, 42)`;

        if (backend === "postgres") yield* migration003Upstream;
        else yield* runMigrations();

        expect([
          ...(yield* sql`SELECT project_id, default_model_selection_json FROM projection_projects ORDER BY project_id`),
        ]).toEqual([
          { project_id: "configured", default_model_selection_json: model },
          { project_id: "seeded", default_model_selection_json: null },
        ]);
        expect([
          ...(yield* sql`SELECT thread_id, settled_at FROM projection_threads ORDER BY thread_id`),
        ]).toEqual([
          { thread_id: "automatic", settled_at: "2026-01-15T12:00:00.000Z" },
          { thread_id: "empty", settled_at: createdAt },
          { thread_id: "manual", settled_at: sweptAt },
        ]);
        expect([
          ...(yield* sql`SELECT thread_id, host, number FROM projection_thread_pull_requests ORDER BY thread_id`),
        ]).toEqual(
          ["automatic", "empty", "manual"].map((thread_id) => ({
            thread_id,
            host: "github.com",
            number: 57,
          })),
        );
        expect([
          ...(yield* sql`SELECT source_thread_id, epoch, source_sequence FROM native_thread_streams`),
        ]).toEqual([{ source_thread_id: "worker-thread", epoch: 7, source_sequence: 42 }]);
        expect([
          ...(yield* sql`SELECT attribution_json, context_json FROM projection_thread_messages WHERE message_id = 'good'`),
        ]).toEqual([{ attribution_json: '{"userId":"canonical-user"}', context_json: null }]);
        expect([
          ...(yield* sql`SELECT started_by_user_id, participants_json FROM projection_threads WHERE thread_id = 'automatic'`),
        ]).toEqual([
          { started_by_user_id: "canonical-user", participants_json: '["canonical-user"]' },
        ]);
        expect([
          ...(yield* sql`SELECT json_type('{"title":"task"}', '$.title') AS kind, json_type('{}', '$.missing') AS missing`),
        ]).toEqual([{ kind: "text", missing: null }]);
        expect([
          ...(yield* sql`SELECT json_array_length('[{"type":"image"}]') AS populated,
            json_array_length('[]') AS empty, json_array_length('{}') AS object,
            json_array_length('null') AS json_null, json_array_length(NULL) AS sql_null`),
        ]).toEqual([{ populated: 1, empty: 0, object: 0, json_null: 0, sql_null: null }]);
        if (backend === "postgres") {
          expect([
            ...(yield* sql`SELECT schema_version, minimum_app_schema_version FROM compadre_t3_schema_compatibility`),
          ]).toEqual([{ schema_version: 3, minimum_app_schema_version: 3 }]);
          yield* sql`DROP SCHEMA compadre_upgrade_fixture CASCADE`;
        }
      }),
    );
  });

it.effect(
  "upgrades populated Compadre SQLite while retaining attribution and native delivery",
  () => verifyUpgrade("sqlite").pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

const url = process.env.COMPADRE_T3_POSTGRES_TEST_URL;
describe.runIf(url)("populated PostgreSQL upgrade", () => {
  it.effect("matches SQLite backfills and retains Compadre-owned data", () =>
    verifyUpgrade("postgres").pipe(Effect.provide(makeTestPostgresPersistence(url!))),
  );
});
