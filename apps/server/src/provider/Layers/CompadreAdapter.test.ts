// @effect-diagnostics nodeBuiltinImport:off - Exercises reconnects against a real SSE socket.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
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
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import { makeCompadreAdapter } from "./CompadreAdapter.ts";
import { remoteNativeProviderSnapshot } from "../RemoteNativeProvider.ts";

it("uses the native Codex catalog instead of stale proxy model aliases", () => {
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
      models: ["claude-code", "codex", "compadre"].map((model) => ({
        slug: model,
        name: model,
        isCustom: true,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    } as ServerProvider,
  });

  assert.deepStrictEqual(
    snapshot.models.map((model) => model.slug),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(snapshot.models[0]?.isDefault, true);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("CompadreAdapter", (it) => {
  it.effect("reconnects a dropped provider stream from its durable SSE cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<{ method: string; lastEventId: string | undefined }> = [];
        const server = createServer((request, response) => {
          requests.push({
            method: request.method ?? "UNKNOWN",
            lastEventId:
              typeof request.headers["last-event-id"] === "string"
                ? request.headers["last-event-id"]
                : undefined,
          });
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "close",
          });
          if (request.method === "POST") {
            response.write(
              'id: cursor-1\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant-1"}\n\n',
            );
            response.write(
              'id: cursor-2\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant-1","delta":"Hello"}\n\n',
            );
            response.end();
            return;
          }
          response.write(
            'id: cursor-3\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant-1"}\n\n',
          );
          response.write('id: cursor-4\ndata: {"type":"RUN_FINISHED","runId":"remote-run"}\n\n');
          response.end("data: [DONE]\n\n");
        });
        const port = yield* Effect.acquireRelease(
          Effect.tryPromise(
            () =>
              new Promise<number>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (!address || typeof address === "string") {
                    reject(new Error("test server did not bind a TCP port"));
                    return;
                  }
                  resolve(address.port);
                });
              }),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close();
                  server.closeAllConnections();
                  resolve();
                }),
            ),
        );
        const codex = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const threadId = ThreadId.make("reconnect-thread");
        const completed = yield* Deferred.make<void>();
        const adapter = yield* makeCompadreAdapter({
          endpoint: `http://127.0.0.1:${port}/hosted/t3/chat`,
          runtimeProvider: codex,
          instanceId,
          provider: "codex",
          reconnectBaseDelayMs: 0,
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          threadId,
          provider: codex,
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "gpt-5.6-sol" },
        });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* Deferred.await(completed);
        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);

        assert.deepStrictEqual(requests, [
          { method: "POST", lastEventId: undefined },
          { method: "GET", lastEventId: "cursor-2" },
        ]);
        assert.equal(
          events.filter(
            (event) => event.type === "content.delta" && event.payload.delta === "Hello",
          ).length,
          1,
        );
        assert.equal(
          events.find((event) => event.type === "turn.completed")?.payload.state,
          "completed",
        );
      }),
    ),
  );

  it.effect("presents a remote worker as the native provider and forwards its model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("remote-codex-thread");
      const codex = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      const requests: Array<{ provider: unknown; model: unknown; modelOptions: unknown }> = [];
      const completed = yield* Deferred.make<void>();
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/t3/chat",
        runtimeProvider: codex,
        instanceId,
        provider: "codex",
        transport: (request) => {
          requests.push({
            provider: request.provider,
            model: request.model,
            modelOptions: request.modelOptions,
          });
          return Stream.make({
            type: "RUN_FINISHED",
            runId: request.runId,
            threadId: request.threadId,
          });
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.startSession({
        threadId,
        provider: codex,
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "gpt-5.6-sol" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "inspect the repo",
        modelSelection: {
          instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.deepStrictEqual(requests, [
        {
          provider: "codex",
          model: "gpt-5.6-sol",
          modelOptions: [{ id: "reasoningEffort", value: "ultra" }],
        },
      ]);
      assert.equal((yield* adapter.listSessions())[0]?.model, "gpt-5.6-sol");
      assert.isTrue(events.every((event) => event.provider === codex));
      assert.equal(adapter.provider, codex);
    }),
  );

  it.effect("turns a Compadre run error into a failed T3 turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-error-thread");
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        provider: "codex",
        transport: () => Stream.make({ type: "RUN_ERROR", message: "Modal failed" }),
      });
      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "fail" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.include(
        events.map((event) => event.type),
        "runtime.error",
      );
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.payload.state, "failed");
      assert.equal(terminal?.payload.errorMessage, "Modal failed");
    }),
  );

  it.effect("preserves native tool types, arguments, and changed file paths", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-tool-thread");
      const completed = yield* Deferred.make<void>();
      let forwardedUserId: string | undefined;
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        provider: "codex",
        transport: (request) => {
          forwardedUserId = request.attribution?.userId;
          return Stream.fromIterable([
            {
              type: "TOOL_CALL_START",
              toolCallId: "command-1",
              toolName: "Bash",
              itemType: "command_execution",
              title: "Command run",
              detail: "Bash: git status --short",
              data: { command: "git status --short" },
            },
            {
              type: "TOOL_CALL_ARGS",
              toolCallId: "command-1",
              args: '{"command":"git status --short"}',
            },
            {
              type: "TOOL_CALL_RESULT",
              toolCallId: "command-1",
              itemType: "command_execution",
              data: { command: "git status --short", rawOutput: " M file.ts" },
            },
            {
              type: "TOOL_CALL_START",
              toolCallId: "write-1",
              toolName: "Write",
              itemType: "file_change",
              title: "File change",
              detail: "Write: src/one.ts, src/two.ts",
              data: {
                changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
              },
            },
            {
              type: "TOOL_CALL_RESULT",
              toolCallId: "write-1",
              itemType: "file_change",
              data: {
                changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
              },
            },
            {
              type: "THREAD_TOKEN_USAGE_UPDATED",
              usage: {
                usedTokens: 39,
                lastInputTokens: 30,
                lastCachedInputTokens: 12,
                lastOutputTokens: 9,
                lastReasoningOutputTokens: 4,
                usageProvider: "codex",
                model: "gpt-5.6-sol",
              },
            },
            { type: "RUN_FINISHED" },
          ]);
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "inspect and edit",
        attribution: {
          userId: "user-1",
          displayName: "Isaac Sherrill",
          origin: "web",
        },
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      const toolEvents = events.filter(
        (event) => event.type === "item.started" || event.type === "item.completed",
      );
      assert.deepInclude(toolEvents[0]?.payload, {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: git status --short",
        data: { command: "git status --short" },
      });
      assert.deepInclude(toolEvents[1]?.payload, {
        itemType: "command_execution",
        data: { command: "git status --short", rawOutput: " M file.ts" },
      });
      assert.deepInclude(toolEvents[2]?.payload, {
        itemType: "file_change",
        data: {
          changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
        },
      });
      assert.deepInclude(toolEvents[3]?.payload, {
        itemType: "file_change",
        data: {
          changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
        },
      });
      const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
      assert.deepInclude(usageEvent?.payload, {
        usage: {
          usedTokens: 39,
          lastInputTokens: 30,
          lastCachedInputTokens: 12,
          lastOutputTokens: 9,
          lastReasoningOutputTokens: 4,
          usageProvider: "codex",
          model: "gpt-5.6-sol",
        },
      });
      assert.equal(forwardedUserId, "user-1");
    }),
  );

  it.effect("forwards T3 image attachments to hosted Compadre", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-compadre-attachments-",
        });
        const attachmentId = "compadre-image-00000000-0000-4000-8000-000000000001";
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, `${attachmentId}.png`),
          new Uint8Array([137, 80, 78, 71]),
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
            });
          },
        });
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "probe.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
        });
        yield* Deferred.await(completed);
        yield* Fiber.interrupt(eventsFiber);
        assert.deepStrictEqual(received, [
          {
            name: "probe.png",
            mimetype: "image/png",
            sizeBytes: 4,
            dataBase64: "iVBORw==",
          },
        ]);
      }),
    ),
  );

  it.effect("downloads durable Compadre output images and files into the assistant message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-compadre-output-",
        });
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const digest = createHash("sha256").update(png).digest("hex");
        const csv = new TextEncoder().encode("service,status\napi,healthy\n");
        const csvDigest = createHash("sha256").update(csv).digest("hex");
        const requests: Array<{
          authorization: string | undefined;
          artifactId: string | null;
        }> = [];
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          requests.push({
            authorization: request.headers.authorization,
            artifactId: url.searchParams.get("artifactId"),
          });
          const bytes = url.searchParams.get("artifactId") === csvDigest ? csv : png;
          response.writeHead(200, { "content-type": "application/octet-stream" });
          response.end(Buffer.from(bytes));
        });
        const port = yield* Effect.acquireRelease(
          Effect.tryPromise(
            () =>
              new Promise<number>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (!address || typeof address === "string") return reject(new Error("no port"));
                  resolve(address.port);
                });
              }),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close();
                  server.closeAllConnections();
                  resolve();
                }),
            ),
        );
        const threadId = ThreadId.make("output-thread");
        const completed = yield* Deferred.make<void>();
        const events: ProviderRuntimeEvent[] = [];
        const adapter = yield* makeCompadreAdapter({
          endpoint: `http://127.0.0.1:${port}/hosted/t3/chat`,
          apiKey: "controller-secret",
          instanceId: ProviderInstanceId.make("codex"),
          runtimeProvider: ProviderDriverKind.make("codex"),
          provider: "codex",
          attachmentsDir,
          transport: () =>
            Stream.fromIterable([
              { type: "TEXT_MESSAGE_START", messageId: "assistant-1" },
              { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "Done" },
              { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
              {
                type: "OUTPUT_ARTIFACT",
                artifact: {
                  artifactId: digest,
                  path: "proof.png",
                  name: "proof.png",
                  title: "proof.png",
                  mimetype: "image/png",
                  sizeBytes: png.byteLength,
                  storage: "hosted-object",
                },
              },
              {
                type: "OUTPUT_ARTIFACT",
                artifact: {
                  artifactId: csvDigest,
                  path: "report.csv",
                  name: "report.csv",
                  title: "report.csv",
                  mimetype: "text/csv",
                  sizeBytes: csv.byteLength,
                  storage: "hosted-object",
                },
              },
              { type: "RUN_FINISHED" },
            ]),
        });
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "create proof" });
        yield* Deferred.await(completed);
        yield* Fiber.interrupt(eventsFiber);

        const attachmentId = `output-thread-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const csvAttachmentId = `output-thread-${csvDigest.slice(0, 8)}-${csvDigest.slice(8, 12)}-${csvDigest.slice(12, 16)}-${csvDigest.slice(16, 20)}-${csvDigest.slice(20, 32)}`;
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(attachmentsDir, `${attachmentId}.png`)),
          png,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(attachmentsDir, `${csvAttachmentId}.csv`)),
          csv,
        );
        const output = events.findLast(
          (event) => event.type === "item.completed" && event.payload.attachments !== undefined,
        );
        assert.deepInclude(output?.payload, {
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "proof.png",
              mimeType: "image/png",
              sizeBytes: png.byteLength,
            },
            {
              type: "file",
              id: csvAttachmentId,
              name: "report.csv",
              mimeType: "text/csv",
              sizeBytes: csv.byteLength,
            },
          ],
        });
        assert.deepStrictEqual(requests, [
          {
            authorization: "Bearer controller-secret",
            artifactId: digest,
          },
          {
            authorization: "Bearer controller-secret",
            artifactId: csvDigest,
          },
        ]);
      }),
    ),
  );

  it.effect("cancels the hosted Compadre run when a T3 turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-cancel-thread");
      const cancelledRunIds: string[] = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        provider: "codex",
        transport: () => Stream.never,
        cancelTransport: ({ runId }) =>
          Effect.sync(() => {
            cancelledRunIds.push(runId);
          }),
      });
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep working" });
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventsFiber);

      assert.equal(cancelledRunIds.length, 1);
      assert.isNotEmpty(cancelledRunIds[0]);
      const terminal = events.find((event) => event.type === "turn.completed");
      assert.equal(terminal?.payload.state, "cancelled");
    }),
  );

  it.effect("steers a running hosted turn without cancelling or opening a second T3 turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-steer-thread");
      const inputs: string[] = [];
      const cancelledRunIds: string[] = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
        instanceId: ProviderInstanceId.make("codex"),
        runtimeProvider: ProviderDriverKind.make("codex"),
        provider: "codex",
        transport: (input) => {
          inputs.push(input.input);
          if (input.input === "initial request") return Stream.never;
          return Stream.fromIterable([
            {
              type: "TEXT_MESSAGE_START",
              messageId: "assistant-steered",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "assistant-steered",
              delta: "Steered answer",
            },
            {
              type: "TEXT_MESSAGE_END",
              messageId: "assistant-steered",
            },
            { type: "RUN_FINISHED" },
          ]);
        },
        cancelTransport: ({ runId }) =>
          Effect.sync(() => {
            cancelledRunIds.push(runId);
          }),
      });
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const initial = yield* adapter.sendTurn({
        threadId,
        input: "initial request",
      });
      yield* Effect.yieldNow;
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "focus on the API instead",
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.equal(String(steered.turnId), String(initial.turnId));
      assert.deepStrictEqual(inputs, ["initial request", "focus on the API instead"]);
      assert.deepStrictEqual(cancelledRunIds, []);
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.state),
        ["completed"],
      );
      assert.equal(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta === "Steered answer",
        ),
        true,
      );
    }),
  );
});
