// @effect-diagnostics nodeBuiltinImport:off - Exercises reconnects against a real SSE socket.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import { makeCompadreAdapter } from "./CompadreAdapter.ts";
import { makeCompadreTransport } from "./CompadreTransport.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { remoteNativeProviderSnapshot } from "../RemoteNativeProvider.ts";

it("preserves discovered models and their capabilities without a hosted allowlist", () => {
  const snapshot = remoteNativeProviderSnapshot({
    agentProvider: "codex",
    enabled: true,
    snapshot: {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      checkedAt: "2026-08-26T00:00:00.000Z",
      models: ["future-model", "another-new-model"].map((model) => ({
        slug: model,
        name: model,
        isCustom: false,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    } as ServerProvider,
  });

  assert.deepStrictEqual(
    snapshot.models.map((model) => model.slug),
    ["future-model", "another-new-model"],
  );
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("CompadreAdapter", (it) => {
  it.effect("reconnects native lifecycle receipts without retransmitting the dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<{ method: string; cursor?: string }> = [];
        const server = NodeHttp.createServer((request, response) => {
          requests.push({
            method: request.method!,
            ...(typeof request.headers["last-event-id"] === "string"
              ? { cursor: request.headers["last-event-id"] }
              : {}),
          });
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "x-compadre-native-delivery": "1",
            Connection: "close",
          });
          response.end(
            request.method === "POST"
              ? 'id: cursor-1\ndata: {"type":"RUN_STARTED"}\n\n'
              : 'id: cursor-2\ndata: {"type":"RUN_FINISHED"}\n\n',
          );
        });
        const port = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (address && typeof address !== "string") resolve(address.port);
                });
              }),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  server.closeAllConnections();
                }),
            ),
        );
        const transport = makeCompadreTransport(
          yield* HttpClient.HttpClient,
          ProviderDriverKind.make("codex"),
          0,
        );
        const received = yield* Stream.runCollect(
          transport({
            endpoint: `http://127.0.0.1:${port}/hosted/t3/chat`,
            apiKey: undefined,
            threadId: "thread",
            runId: "run",
            messageId: "user",
            input: "hello",
            inputFiles: [],
            provider: "codex",
            model: "test",
            modelOptions: [],
            attribution: undefined,
          }),
        );
        assert.deepStrictEqual(
          Array.from(received).map((event) => event.type),
          ["RUN_STARTED", "RUN_FINISHED"],
        );
        assert.deepStrictEqual(requests, [
          { method: "POST" },
          { method: "GET", cursor: "cursor-1" },
        ]);
      }),
    ),
  );

  it.effect("lifecycle completion never synthesizes conversation or closes background work", () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const threadId = ThreadId.make("native-thread");
      const events: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://controller.test/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        transport: () =>
          Stream.make({ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }).pipe(
            Stream.ensuring(Deferred.succeed(done, undefined)),
          ),
      });
      const watcher = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "run in background" });
      yield* Deferred.await(done);
      yield* Fiber.interrupt(watcher);
      assert.isFalse(
        events.some((event) =>
          [
            "turn.started",
            "turn.completed",
            "content.delta",
            "item.started",
            "item.completed",
          ].includes(event.type),
        ),
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }),
  );

  it.effect("surfaces a failed dispatch without fabricating a worker completion", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const threadId = ThreadId.make("failed-thread");
      const events: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://controller.test/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        transport: () => Stream.make({ type: "RUN_ERROR", message: "Worker unavailable" }),
      });
      const watcher = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "runtime.error" ? Deferred.succeed(failed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "start" });
      yield* Deferred.await(failed);
      yield* Fiber.interrupt(watcher);
      assert.equal(
        events.find((event) => event.type === "runtime.error")?.payload.message,
        "Worker unavailable",
      );
      assert.isFalse(events.some((event) => event.type === "turn.completed"));
    }),
  );

  it.effect("steers and cancels explicitly, but detaches without cancellation on shutdown", () =>
    Effect.gen(function* () {
      const starts: string[] = [],
        steers: string[] = [],
        cancelled: string[] = [];
      const threadId = ThreadId.make("control-thread");
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://controller.test/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        transport: (input) => {
          starts.push(input.input);
          return Stream.never;
        },
        steerTransport: (input) =>
          Effect.sync(() => {
            steers.push(input.text);
            return "accepted" as const;
          }),
        cancelTransport: (input) =>
          Effect.sync(() => {
            cancelled.push(input.runId);
          }),
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "steer" });
      assert.deepStrictEqual(starts, ["first"]);
      assert.deepStrictEqual(steers, ["steer"]);
      yield* adapter.interruptTurn(threadId);
      assert.equal(cancelled.length, 1);
      yield* adapter.sendTurn({ threadId, input: "second" });
      yield* Effect.yieldNow;
      yield* adapter.stopAll();
      assert.equal(cancelled.length, 1);
      assert.deepStrictEqual(yield* adapter.listSessions(), []);
    }),
  );
  it.effect("forwards generic file attachments to hosted Compadre", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-compadre-attachments-",
        });
        const attachmentId = "compadre-file-00000000-0000-4000-8000-000000000001";
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, `${attachmentId}.pdf`),
          new Uint8Array([37, 80, 68, 70]),
        );
        const received: Array<{
          name: string;
          mimetype: string;
          sizeBytes: number;
          dataBase64: string;
        }> = [];
        const threadId = ThreadId.make("compadre-attachment-thread");
        const completed = yield* Deferred.make<void>();
        const adapter = yield* makeCompadreAdapter({
          endpoint: "http://compadre.test/hosted/chat",
          instanceId: ProviderInstanceId.make("codex"),
          runtimeProvider: ProviderDriverKind.make("codex"),
          provider: "codex",
          attachmentsDir,
          transport: (request) => {
            received.push(...request.inputFiles);
            return Stream.make({
              type: "RUN_FINISHED",
              runId: request.runId,
              threadId: request.threadId,
            }).pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
          },
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          attachments: [
            {
              type: "file",
              id: attachmentId,
              name: "probe.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
            },
          ],
        });
        yield* Deferred.await(completed);
        assert.deepStrictEqual(received, [
          {
            name: "probe.pdf",
            mimetype: "application/pdf",
            sizeBytes: 4,
            dataBase64: "JVBERg==",
          },
        ]);
      }),
    ),
  );
});
