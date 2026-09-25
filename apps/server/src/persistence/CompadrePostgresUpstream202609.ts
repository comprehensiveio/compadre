import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds the central equivalents of SQLite migrations 55–57. */
export const migration004Upstream = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN auto_settle_disabled_at TEXT`;
  yield* sql`CREATE TABLE pull_request_files_viewed (
    provider TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    viewer TEXT NOT NULL,
    path TEXT NOT NULL,
    revision TEXT,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (provider, host, repository, number, viewer, path)
  )`;
  // Reasoning message roles and auto-settle events require the new reader.
  yield* sql`UPDATE compadre_t3_schema_compatibility
    SET schema_version = 4, minimum_app_schema_version = 4 WHERE singleton_id = 1`;
});
