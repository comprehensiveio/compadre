import { makeNativeThreadControls } from "./NativeThreadControls.ts";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EventId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeTestPostgresPersistence } from "../persistence/PostgresTest.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";

import { mapNativeThreadEvent, nativeId } from "./NativeThreadEvents.ts";
import { HttpRouter, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { bindNativeThreadStream } from "./NativeThreadStreamStore.ts";
import { nativeThreadEventRoutes, readNativeEventPage } from "./NativeThreadEventRoutes.ts";
async function createOrchestrationSystem(central = false) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      central && process.env.COMPADRE_T3_POSTGRES_TEST_URL
        ? makeTestPostgresPersistence(process.env.COMPADRE_T3_POSTGRES_TEST_URL)
        : SqlitePersistenceMemory,
    ),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Replication exercises two independent servers/databases and their HTTP handlers concurrently; each runtime is explicitly disposed.
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    config: await runtime.runPromise(Effect.service(ServerConfig)),
    fileSystem: await runtime.runPromise(Effect.service(FileSystem.FileSystem)),
    snapshotQuery,
    sql: await runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

const createdAt = "2026-09-09T12:00:00.000Z";
async function seed(system: Awaited<ReturnType<typeof createOrchestrationSystem>>, id: ThreadId) {
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`project:${id}`),
      projectId: ProjectId.make(`project:${id}`),
      title: "Project",
      workspaceRoot: `/tmp/native-event-test-${id}`,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-test",
      },
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`thread:${id}`),
      projectId: ProjectId.make(`project:${id}`),
      threadId: id,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-test" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
}

describe("native thread replication", () => {
  it("preserves old history and replays deltas, completion, and later background output exactly once", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    const central = await createOrchestrationSystem(true);
    try {
      await seed(source, sourceThreadId);
      await seed(central, threadId);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 1,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      await central.run(
        central.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("old"),
          threadId,
          messageId: MessageId.make("old-message"),
          delta: "Existing history",
          createdAt,
        }),
      );
      let offset = await source.run(source.engine.latestSequence);
      const append = async (commandId: string, messageId: string, delta: string) =>
        source.run(
          source.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(commandId),
            threadId: sourceThreadId,
            messageId: MessageId.make(messageId),
            delta,
            createdAt,
          }),
        );
      const deliver = async () => {
        const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, offset));
        for (const event of page.events) {
          const command = mapNativeThreadEvent(sourceThreadId, threadId, event, 1);
          if (command) await central.run(central.engine.dispatch(command));
        }
        return page;
      };
      await append("delta-1", "parent", "Waiting on ");
      await append("delta-2", "parent", "background agents");
      await source.run(
        source.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("parent-done"),
          threadId: sourceThreadId,
          messageId: MessageId.make("parent"),
          createdAt,
        }),
      );
      const first = await deliver();
      const sequence = await central.run(central.engine.latestSequence);
      // Lost acknowledgement: redeliver the same page before saving its cursor.
      await deliver();
      expect(await central.run(central.engine.latestSequence)).toBe(sequence);
      offset = first.next;
      await append("child-output", "child", "Background result");
      await append("continuation", "final", "Here is the final answer");
      await deliver();
      const snapshot = await central.readModel();
      expect(
        snapshot.threads
          .find((thread) => thread.id === threadId)
          ?.messages.map((message) => [message.id, message.text])
          .sort(),
      ).toEqual(
        [
          ["old-message", "Existing history"],
          [nativeId(sourceThreadId, "parent"), "Waiting on background agents"],
          [nativeId(sourceThreadId, "child"), "Background result"],
          [nativeId(sourceThreadId, "final"), "Here is the final answer"],
        ].sort(),
      );
      expect(
        snapshot.threads
          .find((thread) => thread.id === threadId)
          ?.messages.find((message) => message.id === nativeId(sourceThreadId, "parent"))
          ?.streaming,
      ).toBe(false);
      const event = first.events.find((event) => event.type === "thread.message-sent");
      if (!event || event.type !== "thread.message-sent") throw new Error("Missing test event");
      const conflict = mapNativeThreadEvent(
        sourceThreadId,
        threadId,
        {
          ...event,
          payload: { ...event.payload, text: "Changed source data" },
        },
        1,
      );
      expect(conflict).not.toBeNull();
      await expect(central.run(central.engine.dispatch(conflict!))).rejects.toThrow();
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === threadId)?.messages,
      ).toEqual(snapshot.threads.find((thread) => thread.id === threadId)?.messages);
      expect(() => mapNativeThreadEvent(ThreadId.make("wrong-thread"), threadId, event, 1)).toThrow(
        "bound source thread",
      );
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });

  it("a lost worker closes only its current claim and retries cannot stop its replacement", async () => {
    const central = await createOrchestrationSystem(true);
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    try {
      await seed(central, threadId);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 1,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 2,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      const command = {
        type: "thread.native-stream.close" as const,
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        sourceThreadId,
        epoch: 1,
        createdAt,
        reason: "Worker terminated",
      };
      await expect(central.run(central.engine.dispatch(command))).rejects.toThrow("superseded");
      await central.run(central.engine.dispatch({ ...command, epoch: 2 }));
      const after = await central.readModel();
      expect(after.threads.find((thread) => thread.id === threadId)?.session?.status).toBe(
        "stopped",
      );
      const sequence = after.snapshotSequence;
      await central.run(central.engine.dispatch({ ...command, epoch: 2 }));
      expect((await central.readModel()).snapshotSequence).toBe(sequence);
    } finally {
      await central.dispose();
    }
  });

  it("routes native question responses from the persisted binding without an adapter session", async () => {
    const previous = process.env.COMPADRE_NATIVE_T3_URL;
    process.env.COMPADRE_NATIVE_T3_URL = "https://controller.example/hosted/t3/chat";
    const central = await createOrchestrationSystem(true);
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const requests: unknown[] = [];
    try {
      await seed(central, threadId);
      const control = await central.run(
        makeNativeThreadControls.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push(request.url);
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ accepted: true })),
              );
            }),
          ),
        ),
      );
      const event = {
        sequence: 1,
        eventId: EventId.make("control"),
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.user-input-response-requested" as const,
        payload: {
          threadId,
          createdAt,
          requestId: "request" as import("@t3tools/contracts").ApprovalRequestId,
          answers: { option: "A" },
        },
      };
      expect(await central.run(control(event))).toBe(false);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 3,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      expect(await central.run(control(event))).toBe(true);
      expect(requests).toEqual([
        `https://controller.example/hosted/t3/native-threads/${threadId}/control`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.COMPADRE_NATIVE_T3_URL;
      else process.env.COMPADRE_NATIVE_T3_URL = previous;
      await central.dispose();
    }
  });

  it("advances over other aggregates without exposing their events and bounds each page", async () => {
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    try {
      await seed(source, sourceThreadId);
      for (let index = 0; index < 130; index++) {
        await source.run(
          source.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`delta-${index}`),
            threadId: sourceThreadId,
            messageId: MessageId.make("message"),
            delta: "a",
            createdAt,
          }),
        );
      }
      const first = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      expect(first.next).toBe(128);
      expect(first.upToDate).toBe(false);
      expect(first.events.every((event) => event.aggregateId === sourceThreadId)).toBe(true);
      const last = await source.run(readNativeEventPage(source.engine, sourceThreadId, first.next));
      expect(last.next).toBe(132);
      expect(last.upToDate).toBe(true);
      expect(last.events).toHaveLength(4);
    } finally {
      await source.dispose();
    }
  });
  it("authenticates HTTP reads and accepts a batch only after its commands are durable", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    const central = await createOrchestrationSystem(true);
    const previousKey = process.env.COMPADRE_API_KEY;
    process.env.COMPADRE_API_KEY = "native-test-controller";
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateHttpRequest: (request) =>
        ["Bearer worker-test", "Bearer worker-writer"].includes(request.headers.authorization ?? "")
          ? Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token" as const,
              scopes:
                request.headers.authorization === "Bearer worker-writer"
                  ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
                  : [AuthOrchestrationReadScope],
            })
          : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    });
    const serve = (system: typeof source) =>
      HttpRouter.toWebHandler(
        nativeThreadEventRoutes.pipe(
          Layer.provideMerge(Layer.succeed(OrchestrationEngineService, system.engine)),
          Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, system.snapshotQuery)),
          Layer.provideMerge(auth),
          Layer.provideMerge(Layer.succeed(ServerConfig, system.config)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, system.sql)),
        ),
        { disableLogger: true },
      );
    const worker = serve(source);
    const receiver = serve(central);
    const url = "http://localhost/api/compadre/native-events";
    try {
      await seed(source, sourceThreadId);
      await seed(central, threadId);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 1,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      await source.run(
        source.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("question"),
          threadId: sourceThreadId,
          activity: {
            id: EventId.make("question"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Choose an option",
            payload: {
              requestId: "request-1",
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Which one?",
                  options: [
                    { label: "A", description: "First" },
                    { label: "B", description: "Second" },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        }),
      );
      const attachment = {
        type: "file" as const,
        id: `pending-${NodeCrypto.randomUUID()}-txt`,
        name: "result.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      };
      const path = resolveAttachmentPath({
        attachmentsDir: source.config.attachmentsDir,
        attachment,
      });
      if (!path) throw new Error("Invalid test attachment path");
      await source.run(source.fileSystem.writeFileString(path, "native bytes"));
      const output = {
        type: "thread.message.assistant.complete",
        commandId: "file-output",
        threadId: sourceThreadId,
        messageId: "file-output",
        attachments: [attachment],
        createdAt,
      };
      const outputRequest = (token: string) =>
        new Request("http://localhost/api/compadre/native-output", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(output),
        });
      expect((await worker.handler(outputRequest("worker-test"))).status).toBe(403);
      expect((await worker.handler(outputRequest("worker-writer"))).status).toBe(200);
      const file = await worker.handler(
        new Request(`http://localhost/api/compadre/native-attachment?id=${attachment.id}`, {
          headers: { authorization: "Bearer worker-test" },
        }),
      );
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("native bytes");
      const readUrl = `${url}?threadId=${sourceThreadId}&offset=-1`;
      expect((await worker.handler(new Request(readUrl))).status).toBe(401);
      const page = await worker.handler(
        new Request(readUrl, { headers: { authorization: "Bearer worker-test" } }),
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("stream-up-to-date")).toBe("true");
      expect(page.headers.get("stream-next-offset")).toBe("00000000000000000004");
      const events: unknown = await page.json();
      const body = JSON.stringify({ version: 1, sourceThreadId, epoch: 1, events });
      const post = () =>
        receiver.handler(
          new Request(`${url}?threadId=${threadId}`, {
            method: "POST",
            headers: {
              authorization: "Bearer native-test-controller",
              "content-type": "application/json",
            },
            body,
          }),
        );
      expect(
        (
          await receiver.handler(
            new Request(`${url}?threadId=${threadId}`, { method: "POST", body }),
          )
        ).status,
      ).toBe(401);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      const activities = (await central.readModel()).threads.find(
        (thread) => thread.id === threadId,
      )?.activities;
      expect(activities).toHaveLength(1);
      expect(activities?.[0]?.payload).toMatchObject({
        requestId: nativeId(sourceThreadId, "request-1"),
      });
      const head = await worker.handler(
        new Request(readUrl, { method: "HEAD", headers: { authorization: "Bearer worker-test" } }),
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("stream-next-offset")).toBe("00000000000000000004");
      const waiting = worker.handler(
        new Request(
          `${url}?threadId=${sourceThreadId}&offset=00000000000000000004&live=long-poll`,
          {
            headers: { authorization: "Bearer worker-test" },
          },
        ),
      );
      await source.run(
        source.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("late-output"),
          threadId: sourceThreadId,
          messageId: MessageId.make("late-output"),
          delta: "Later continuation",
          createdAt,
        }),
      );
      const later = await waiting;
      expect(later.status).toBe(200);
      expect(await later.json()).toMatchObject([
        { type: "thread.message-sent", payload: { text: "Later continuation" } },
      ]);
    } finally {
      if (previousKey === undefined) delete process.env.COMPADRE_API_KEY;
      else process.env.COMPADRE_API_KEY = previousKey;
      await worker.dispose();
      await receiver.dispose();
      await source.dispose();
      await central.dispose();
    }
  });

  it("fences a stale generation without advancing the cursor or poisoning a valid retry", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    const central = await createOrchestrationSystem(true);
    try {
      await seed(source, sourceThreadId);
      await seed(central, threadId);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 2,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      await source.run(
        source.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("new"),
          threadId: sourceThreadId,
          messageId: MessageId.make("new"),
          delta: "New generation",
          createdAt,
        }),
      );
      const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, 2));
      const event = page.events[0]!;
      await expect(
        central.run(
          central.engine.dispatch(mapNativeThreadEvent(sourceThreadId, threadId, event, 1)!),
        ),
      ).rejects.toThrow("superseded");
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === threadId)?.messages,
      ).toHaveLength(0);
      await central.run(
        central.engine.dispatch(mapNativeThreadEvent(sourceThreadId, threadId, event, 2)!),
      );
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === threadId)?.messages[0]
          ?.text,
      ).toBe("New generation");
      await expect(
        central.run(
          bindNativeThreadStream({
            threadId,
            sourceThreadId,
            epoch: 1,
            sourceSequence: 0,
            checkpointOffset: 0,
          }),
        ),
      ).rejects.toThrow();
      // A repeated claim must not reset its cursor to the original cutover point.
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 2,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      const rows = await central.run(
        central.sql<{
          source_sequence: number;
        }>`SELECT source_sequence FROM native_thread_streams WHERE thread_id = ${threadId}`,
      );
      expect(rows[0]?.source_sequence).toBe(event.sequence);
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });
  it("keeps background work visible after the parent ends and across a central PostgreSQL restart", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    let central = await createOrchestrationSystem(true);
    try {
      await seed(source, sourceThreadId);
      await seed(central, threadId);
      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 1,
          sourceSequence: 0,
          checkpointOffset: 0,
        }),
      );
      let offset = 2;
      const activity = async (kind: string, payload: unknown) => {
        await source.run(
          source.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(kind),
            threadId: sourceThreadId,
            activity: {
              id: EventId.make(kind),
              tone: "info",
              kind,
              summary: kind,
              payload,
              turnId: null,
              createdAt,
            },
            createdAt,
          }),
        );
        const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, offset));
        for (const event of page.events)
          await central.run(
            central.engine.dispatch(mapNativeThreadEvent(sourceThreadId, threadId, event, 1)!),
          );
        offset = page.next;
      };
      const status = async () =>
        Option.getOrThrow(await central.run(central.snapshotQuery.getThreadShellById(threadId)))
          .backgroundLiveness;
      await activity("task.started", { taskId: "child", taskType: "agent" });
      await activity("provider.turn.completed", { state: "completed" });
      expect(await status()).toBe("working");
      if (process.env.COMPADRE_T3_POSTGRES_TEST_URL) {
        await central.dispose();
        central = await createOrchestrationSystem(true);
        expect(await status()).toBe("working");
      }
      await activity("task.completed", { taskId: "child", status: "completed" });
      expect(await status()).toBeNull();
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });
});
