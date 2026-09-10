import { ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceBackend } from "../persistence/Services/PersistenceBackend.ts";

export class NativeThreadStreamConflict extends Data.TaggedError("NativeThreadStreamConflict")<{
  readonly detail: string;
}> {}

export interface NativeThreadStreamBinding {
  readonly threadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly epoch: number;
  readonly sourceSequence: number;
  readonly checkpointOffset: number;
}

/** Called under the same transaction/locks as native event append and projection. */
export const advanceNativeThreadStream = Effect.fn("advanceNativeThreadStream")(function* (
  input: Omit<NativeThreadStreamBinding, "checkpointOffset">,
) {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* sql<{ checkpoint_offset: number }>`
    UPDATE native_thread_streams SET source_sequence = ${input.sourceSequence}
    WHERE thread_id = ${input.threadId} AND source_thread_id = ${input.sourceThreadId}
      AND epoch = ${input.epoch} AND source_sequence < ${input.sourceSequence}
    RETURNING checkpoint_offset
  `;
  if (changed.length !== 1)
    return yield* new NativeThreadStreamConflict({
      detail: "Native stream is unbound, superseded, or delivered out of order.",
    });
  return changed[0]!.checkpoint_offset;
});

/** A restore claims a higher epoch; an equal claim must match byte for byte. */
export const bindNativeThreadStream = Effect.fn("bindNativeThreadStream")(function* (
  input: NativeThreadStreamBinding,
) {
  const sql = yield* SqlClient.SqlClient;
  const backend = yield* Effect.serviceOption(PersistenceBackend);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (Option.isSome(backend)) {
        yield* backend.value.lockOrchestrationCommitOrder;
        yield* backend.value.lockOrchestrationKeys([{ scope: "thread", key: input.threadId }]);
      }
      const thread =
        yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${input.threadId}`;
      if (thread.length !== 1)
        return yield* new NativeThreadStreamConflict({ detail: "Central thread does not exist." });
      const current = yield* sql<{
        source_thread_id: string;
        epoch: number;
        source_sequence: number;
        checkpoint_offset: number;
      }>`
      SELECT * FROM native_thread_streams WHERE thread_id = ${input.threadId}
    `;
      const previous = current[0];
      if (
        previous &&
        previous.source_thread_id === input.sourceThreadId &&
        previous.checkpoint_offset !== input.checkpointOffset
      ) {
        return yield* new NativeThreadStreamConflict({
          detail: "An existing source journal must retain its checkpoint mapping.",
        });
      }
      if (previous && previous.epoch >= input.epoch) {
        if (
          previous.epoch === input.epoch &&
          previous.source_thread_id === input.sourceThreadId &&
          previous.checkpoint_offset === input.checkpointOffset &&
          previous.source_sequence >= input.sourceSequence
        )
          return;
        return yield* new NativeThreadStreamConflict({
          detail: "Native stream claim was superseded or conflicts with its binding.",
        });
      }
      yield* sql`
      INSERT INTO native_thread_streams(thread_id, source_thread_id, epoch, source_sequence, checkpoint_offset)
      VALUES (${input.threadId}, ${input.sourceThreadId}, ${input.epoch}, ${input.sourceSequence}, ${input.checkpointOffset})
      ON CONFLICT(thread_id) DO UPDATE SET source_thread_id = excluded.source_thread_id,
        epoch = excluded.epoch, source_sequence = excluded.source_sequence, checkpoint_offset = excluded.checkpoint_offset
    `;
    }),
  );
});
