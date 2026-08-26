import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
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

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("CompadreAdapter", (it) => {
  it.effect("maps a Compadre AG-UI text turn to T3 runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-thread");
      const requests: Array<{
        readonly input: string;
        readonly threadId: string;
        readonly provider: "claude-code" | "codex" | undefined;
      }> = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
        instanceId: ProviderInstanceId.make("compadre"),
        transport: (request) => {
          requests.push({
            input: request.input,
            threadId: request.threadId,
            provider: request.provider,
          });
          return Stream.fromIterable([
            { type: "RUN_STARTED", runId: request.runId, threadId: request.threadId },
            {
              type: "TEXT_MESSAGE_START",
              messageId: "assistant-1",
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "assistant-1",
              delta: "hello from Modal",
            },
            { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
            { type: "RUN_FINISHED", runId: request.runId, threadId: request.threadId },
          ]);
        },
      });

      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "session.state.changed" &&
              event.payload.reason === "Compadre turn completed"
              ? Deferred.succeed(completed, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("compadre"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("compadre"),
          model: "claude-code",
        },
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "inspect the repo",
        modelSelection: {
          instanceId: ProviderInstanceId.make("compadre"),
          model: "codex",
        },
      });

      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.equal(session.provider, "compadre");
      assert.equal(turn.threadId, threadId);
      assert.deepStrictEqual(requests, [
        { input: "inspect the repo", threadId, provider: "codex" },
      ]);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "item.completed",
          "turn.completed",
          "session.state.changed",
        ],
      );
      const delta = events.find((event) => event.type === "content.delta");
      assert.equal(delta?.payload.delta, "hello from Modal");
      const terminalSessionState = events.at(-1);
      assert.equal(terminalSessionState?.type, "session.state.changed");
      if (terminalSessionState?.type === "session.state.changed") {
        assert.equal(terminalSessionState.payload.state, "ready");
        assert.equal(terminalSessionState.payload.reason, "Compadre turn completed");
      }
    }),
  );

  it.effect("turns a Compadre run error into a failed T3 turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-error-thread");
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
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

  it.effect("cancels the hosted Compadre run when a T3 turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("compadre-cancel-thread");
      const cancelledRunIds: string[] = [];
      const adapter = yield* makeCompadreAdapter({
        endpoint: "http://compadre.test/hosted/chat",
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
});
