import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  NativeWorkerOutputCommand,
  AuthOrchestrationOperateScope,
  NativeThreadStreamCloseCommand,
  AuthOrchestrationReadScope,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceBackend } from "../persistence/Services/PersistenceBackend.ts";
import * as Stream from "effect/Stream";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { bindNativeThreadStream } from "./NativeThreadStreamStore.ts";
import { NativeThreadEventBatch, mapNativeThreadEvent } from "./NativeThreadEvents.ts";

const NATIVE_THREAD_EVENTS_PATH = "/api/compadre/native-events";
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeBatch = Schema.decodeUnknownEffect(NativeThreadEventBatch);
const decodeClose = Schema.decodeUnknownEffect(NativeThreadStreamCloseCommand);
const decodeOutput = Schema.decodeUnknownEffect(NativeWorkerOutputCommand);
const PAGE_SIZE = 128;
const headers = { "cache-control": "no-store", "x-compadre-native-event-version": "1" };
const nativeOffset = (sequence: number) => String(sequence).padStart(20, "0");

function parseNativeOffset(value: string | null): number {
  if (value === null || value === "-1") return 0;
  if (!/^\d{20}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Invalid native event offset.");
  }
  return Number(value);
}

/** The existing T3 event store is the source journal; no snapshot-to-event reconstruction. */
export const readNativeEventPage = Effect.fn("readNativeEventPage")(function* (
  engine: OrchestrationEngineShape,
  threadId: ThreadId,
  after: number,
) {
  const tail = yield* engine.latestSequence;
  if (after > tail) throw new Error("Native event offset exceeds this worker's journal.");
  const records = yield* Stream.runCollect(engine.readEvents(after, PAGE_SIZE));
  const next = records.at(-1)?.sequence ?? after;
  return {
    events: records.filter(
      (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
    ),
    next,
    upToDate: next >= tail,
  };
});

const read = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = new URL(request.url, "http://localhost").searchParams;
  const decoded = yield* Effect.gen(function* () {
    const threadId = yield* decodeThreadId(params.get("threadId"));
    const after = yield* Effect.try(() => parseNativeOffset(params.get("offset")));
    return { threadId, after };
  }).pipe(Effect.option);
  if (Option.isNone(decoded)) return HttpServerResponse.empty({ status: 400 });
  const { threadId, after } = decoded.value;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const shell = yield* query.getThreadShellById(threadId);
  if (Option.isNone(shell)) {
    return HttpServerResponse.empty({ status: 404 });
  }
  const tail = yield* engine.latestSequence;
  if (request.method === "HEAD")
    return HttpServerResponse.empty({
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/json",
        "stream-next-offset": nativeOffset(tail),
        "x-compadre-background-liveness": shell.value.backgroundLiveness ?? "none",
        "x-compadre-session-status": shell.value.session?.status ?? "idle",
      },
    });
  if (after > tail)
    return HttpServerResponse.jsonUnsafe(
      { error: "Worker journal has moved behind the supplied offset; reconcile its generation." },
      { status: 409, headers },
    );
  const live = params.get("live");
  if (live !== null && live !== "long-poll") return HttpServerResponse.empty({ status: 400 });
  // Subscribe before checking the journal so a commit between read and wait cannot be lost.
  const wake = yield* engine.streamDomainEvents.pipe(
    Stream.runHead,
    Effect.forkScoped({ startImmediately: true }),
  );
  let page = yield* readNativeEventPage(engine, threadId, after);
  if (live === "long-poll" && page.upToDate && page.events.length === 0) {
    yield* Fiber.join(wake).pipe(Effect.timeoutOption("20 seconds"));
    page = yield* readNativeEventPage(engine, threadId, page.next);
  }
  return HttpServerResponse.jsonUnsafe(page.events, {
    headers: {
      ...headers,
      "stream-next-offset": nativeOffset(page.next),
      ...(page.upToDate ? { "stream-up-to-date": "true" } : {}),
      ...(live ? { "stream-cursor": NodeCrypto.randomUUID() } : {}),
    },
  });
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

const bindingSchema = Schema.Struct({
  sourceThreadId: ThreadId,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  sourceSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  checkpointOffset: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const decodeBinding = Schema.decodeUnknownEffect(bindingSchema);

const receive = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const expected = process.env.COMPADRE_API_KEY?.trim();
  const supplied = request.headers.authorization;
  if (
    !expected ||
    !supplied ||
    !NodeCrypto.timingSafeEqual(
      NodeCrypto.createHash("sha256").update(supplied).digest(),
      NodeCrypto.createHash("sha256").update(`Bearer ${expected}`).digest(),
    )
  )
    return HttpServerResponse.empty({ status: 401 });
  const threadId = new URL(request.url, "http://localhost").searchParams.get("threadId");
  if (request.method === "DELETE") {
    const input = yield* Effect.gen(function* () {
      const canonical = yield* decodeThreadId(threadId);
      const body = yield* request.json;
      return yield* decodeClose({
        ...(typeof body === "object" && body !== null ? body : {}),
        type: "thread.native-stream.close",
        threadId: canonical,
      });
    }).pipe(Effect.option);
    if (Option.isNone(input)) return HttpServerResponse.empty({ status: 400 });
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch(input.value);
    return HttpServerResponse.jsonUnsafe({ closed: true }, { headers });
  }
  if (request.method === "PUT") {
    const input = yield* Effect.gen(function* () {
      const canonical = yield* decodeThreadId(threadId);
      const binding = yield* request.json.pipe(Effect.flatMap(decodeBinding));
      return { ...binding, threadId: canonical };
    }).pipe(Effect.option);
    if (Option.isNone(input)) return HttpServerResponse.empty({ status: 400 });
    return yield* bindNativeThreadStream(input.value).pipe(
      Effect.as(HttpServerResponse.jsonUnsafe({ bound: true }, { headers })),
      Effect.catchTag("NativeThreadStreamConflict", (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.detail }, { status: 409, headers }),
        ),
      ),
    );
  }
  const decoded = yield* Effect.gen(function* () {
    const canonical = yield* decodeThreadId(threadId);
    const batch = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(8 * 1024 * 1024)),
      Effect.flatMap(decodeBatch),
    );
    const commands = yield* Effect.try(() =>
      batch.events
        .map((event) => mapNativeThreadEvent(batch.sourceThreadId, canonical, event, batch.epoch))
        .filter((command) => command !== null),
    );
    return commands;
  }).pipe(Effect.option);
  if (Option.isNone(decoded)) return HttpServerResponse.empty({ status: 400 });
  const engine = yield* OrchestrationEngineService;
  for (const command of decoded.value) yield* engine.dispatch(command);
  return HttpServerResponse.jsonUnsafe({ accepted: true }, { headers });
});

const workerOutput = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const command = yield* request.json.pipe(Effect.flatMap(decodeOutput), Effect.option);
  if (Option.isNone(command)) return HttpServerResponse.empty({ status: 400 });
  const engine = yield* OrchestrationEngineService;
  return HttpServerResponse.jsonUnsafe(yield* engine.dispatch(command.value), { headers });
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

const workerAttachment = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const id = new URL(request.url, "http://localhost").searchParams.get("id");
  const path = id
    ? resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId: id })
    : null;
  if (!path) return HttpServerResponse.empty({ status: 400 });
  const bytes = yield* fs.readFile(path).pipe(Effect.option);
  if (Option.isNone(bytes)) return HttpServerResponse.empty({ status: 404 });
  return HttpServerResponse.uint8Array(bytes.value, { headers });
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

export const nativeThreadEventRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const backend = yield* Effect.serviceOption(PersistenceBackend);
    const write = receive.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const boundWrite = Option.isSome(backend)
      ? write.pipe(Effect.provideService(PersistenceBackend, backend.value))
      : write;
    return Layer.mergeAll(
      HttpRouter.add("POST", "/api/compadre/native-output", workerOutput),
      HttpRouter.add("GET", "/api/compadre/native-attachment", workerAttachment),
      HttpRouter.add("GET", NATIVE_THREAD_EVENTS_PATH, read),
      HttpRouter.add("POST", NATIVE_THREAD_EVENTS_PATH, boundWrite),
      HttpRouter.add("PUT", NATIVE_THREAD_EVENTS_PATH, boundWrite),
      HttpRouter.add("DELETE", NATIVE_THREAD_EVENTS_PATH, boundWrite),
    );
  }),
);
