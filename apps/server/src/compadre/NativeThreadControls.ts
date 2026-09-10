import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpBody } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type NativeControlEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.turn-interrupt-requested"
      | "thread.session-stop-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested";
  }
>;

/** Controls use the persisted binding, including after the provider adapter restarts. */
export const makeNativeThreadControls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const http = yield* HttpClient.HttpClient;
  return (event: NativeControlEvent) =>
    Effect.gen(function* () {
      const endpoint = process.env.COMPADRE_NATIVE_T3_URL?.trim();
      if (!endpoint) return false;
      const rows = yield* sql<{ source_thread_id: string; epoch: number }>`
      SELECT source_thread_id, epoch FROM native_thread_streams WHERE thread_id = ${event.payload.threadId}
    `;
      const binding = rows[0];
      if (!binding) return false;
      const url = new URL(endpoint);
      url.pathname = `/hosted/t3/native-threads/${encodeURIComponent(event.payload.threadId)}/control`;
      yield* http
        .execute(
          HttpClientRequest.post(url.toString(), {
            headers: { authorization: `Bearer ${process.env.COMPADRE_API_KEY ?? ""}` },
            body: HttpBody.jsonUnsafe({
              sourceThreadId: binding.source_thread_id,
              epoch: binding.epoch,
              commandId: `native-control:${event.eventId}`,
              type: event.type,
              ...event.payload,
            }),
          }),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.timeout("30 seconds"),
        );
      return true;
    });
});

export class NativeThreadControls extends Context.Service<
  NativeThreadControls,
  Effect.Success<typeof makeNativeThreadControls>
>()("t3/compadre/NativeThreadControls") {}
export const NativeThreadControlsLive = Layer.effect(
  NativeThreadControls,
  makeNativeThreadControls,
);
