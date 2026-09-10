import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Delivery ownership and checkpoint only; conversation events stay in the T3 event store. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE native_thread_streams (
    thread_id TEXT PRIMARY KEY,
    source_thread_id TEXT NOT NULL,
    epoch BIGINT NOT NULL,
    source_sequence BIGINT NOT NULL,
    checkpoint_offset BIGINT NOT NULL DEFAULT 0
  )`;
});
