import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import migratePullRequests from "./Migrations/053_ProjectionThreadPullRequests.ts";

/** PostgreSQL counterpart of SQLite migrations 046–054, upgrading deployed v2 data. */
export const migration003Upstream = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN auto_pull BIGINT NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN project_icon_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN branch_pull_request_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN active_order_key TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT`;

  yield* sql`
    CREATE OR REPLACE FUNCTION json_array_length(document TEXT)
    RETURNS INTEGER LANGUAGE SQL IMMUTABLE STRICT AS $$
      SELECT CASE WHEN jsonb_typeof(document::jsonb) = 'array'
        THEN jsonb_array_length(document::jsonb) ELSE 0 END
    $$
  `;

  // Shared repositories use SQLite's scalar JSON type names and dotted paths.
  yield* sql`
    CREATE OR REPLACE FUNCTION json_type(document TEXT, path TEXT)
    RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$
      SELECT CASE jsonb_typeof(value)
        WHEN 'string' THEN 'text'
        WHEN 'boolean' THEN value::text
        WHEN 'number' THEN CASE WHEN value::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
        ELSE jsonb_typeof(value)
      END
      FROM (SELECT document::jsonb #> string_to_array(substr(path, 3), '.') AS value) AS extracted
    $$
  `;

  // Match upstream's removal of automatically seeded defaults; explicit user
  // metadata changes preserve the project's chosen model, including resets.
  const seeded = yield* sql<{ projectId: string }>`
    SELECT created.stream_id AS "projectId"
    FROM orchestration_events AS created
    WHERE created.aggregate_kind = 'project'
      AND created.event_type = 'project.created'
      AND json_type(created.payload_json, '$.defaultModelSelection') IS NOT NULL
      AND json_type(created.payload_json, '$.defaultModelSelection') <> 'null'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events AS configured
        WHERE configured.aggregate_kind = 'project'
          AND configured.stream_id = created.stream_id
          AND configured.event_type = 'project.meta-updated'
          AND json_type(configured.payload_json, '$.defaultModelSelection') IS NOT NULL
      )
  `;
  for (const { projectId } of seeded) {
    yield* sql`UPDATE projection_projects SET default_model_selection_json = NULL WHERE project_id = ${projectId}`;
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = jsonb_set(payload_json::jsonb, '{defaultModelSelection}', 'null'::jsonb)::text
      WHERE aggregate_kind = 'project' AND event_type = 'project.created' AND stream_id = ${projectId}
    `;
  }

  // Ignore malformed historical activity timestamps just as SQLite julianday
  // does, retaining the original timestamp bytes for the selected activity.
  const settlements = yield* sql<{ threadId: string; createdAt: string; settledAt: string }>`
    SELECT DISTINCT thread.thread_id AS "threadId", thread.created_at AS "createdAt",
      thread.settled_at AS "settledAt"
    FROM projection_threads AS thread
    JOIN orchestration_events AS automatic ON automatic.stream_id = thread.thread_id
    WHERE thread.settled_override = 'settled'
      AND automatic.aggregate_kind = 'thread' AND automatic.event_type = 'thread.settled'
      AND automatic.actor_kind = 'server' AND automatic.command_id LIKE 'server:auto-settle:%'
      AND json_type(automatic.payload_json, '$.settledAt') = 'text'
      AND json_extract(automatic.payload_json, '$.settledAt') = automatic.occurred_at
      AND automatic.occurred_at = thread.settled_at
  `;
  for (const thread of settlements) {
    const activities = yield* sql<{ at: string | null }>`
      SELECT created_at AS at FROM projection_thread_messages WHERE thread_id = ${thread.threadId} AND role = 'user'
      UNION ALL SELECT requested_at FROM projection_turns WHERE thread_id = ${thread.threadId}
      UNION ALL SELECT started_at FROM projection_turns WHERE thread_id = ${thread.threadId}
      UNION ALL SELECT completed_at FROM projection_turns WHERE thread_id = ${thread.threadId}
    `;
    const end = Date.parse(thread.settledAt);
    let latest = thread.createdAt;
    let latestTime = -Infinity;
    for (const { at } of activities) {
      if (at === null) continue;
      const time = Date.parse(at);
      if (time <= end && time > latestTime) {
        latest = at;
        latestTime = time;
      }
    }
    yield* sql`UPDATE projection_threads SET settled_at = ${latest} WHERE thread_id = ${thread.threadId}`;
  }

  yield* migratePullRequests;
  // New persisted commands/events are not understood by the old application.
  yield* sql`UPDATE compadre_t3_schema_compatibility SET schema_version = 3, minimum_app_schema_version = 3 WHERE singleton_id = 1`;
});
