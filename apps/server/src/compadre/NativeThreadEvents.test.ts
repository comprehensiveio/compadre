import { makeNativeThreadControls } from "./NativeThreadControls.ts";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentId,
  EventId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Stream from "effect/Stream";
import { hostedPullRequestRoutes } from "./HostedPullRequestRoutes.ts";
import { PullRequestsToolkitHandlersLive } from "../mcp/toolkits/pullRequests/handlers.ts";
import {
  PullRequestsToolkit,
  type PullRequestTargetInput,
} from "../mcp/toolkits/pullRequests/tools.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import {
  pullRequestAccessProjection,
  forwardPullRequestRequest,
} from "../../../../hosted/compadre/src/t3/pull-request-access.ts";

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
import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { HttpRouter, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { bindNativeThreadStream } from "./NativeThreadStreamStore.ts";
import { nativeThreadEventRoutes, readNativeEventPage } from "./NativeThreadEventRoutes.ts";
import { providerActionRoutes } from "./ProviderActionRoutes.ts";
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
  it("persists reasoning from a worker once across replay and fences old generations", async () => {
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
          type: "thread.message.reasoning.delta",
          commandId: CommandId.make("reasoning-delta"),
          threadId: sourceThreadId,
          messageId: MessageId.make("thought"),
          delta: "Checking the fixture",
          createdAt,
        }),
      );
      await source.run(
        source.engine.dispatch({
          type: "thread.message.reasoning.complete",
          commandId: CommandId.make("reasoning-done"),
          threadId: sourceThreadId,
          messageId: MessageId.make("thought"),
          createdAt,
        }),
      );
      const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      const commands = page.events.flatMap((event) => {
        const command = mapNativeThreadEvent(sourceThreadId, threadId, event, 2);
        return command ? [command] : [];
      });
      expect(commands).toHaveLength(2);
      await expect(
        central.run(central.engine.dispatch({ ...commands[0]!, epoch: 1 })),
      ).rejects.toThrow();
      for (const command of commands) await central.run(central.engine.dispatch(command));
      const sequence = await central.run(central.engine.latestSequence);
      for (const command of commands) await central.run(central.engine.dispatch(command));
      expect(await central.run(central.engine.latestSequence)).toBe(sequence);
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === threadId)?.messages,
      ).toMatchObject([{ role: "reasoning", text: "Checking the fixture", streaming: false }]);
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });

  it("persists worker branch discovery without importing paths or overwriting explicit PR links", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    const central = await createOrchestrationSystem(true);
    let serial = 0;
    const commandId = () => CommandId.make(`branch-test:${threadId}:${++serial}`);
    const current = async () => (await central.readModel()).threads.find((t) => t.id === threadId)!;
    const updateBranch = async (branch: string | null) =>
      source.run(
        source.engine.dispatch({
          type: "thread.meta.update",
          commandId: commandId(),
          threadId: sourceThreadId,
          branch,
          title: "Worker-only title",
          worktreePath: "/workspace/worker-only-path",
        }),
      );
    const discover = async (number: number | null) => {
      const snapshot = await source.readModel();
      const thread = snapshot.threads[0]!;
      await source.run(
        source.engine.dispatch({
          type: "thread.pull-request.sync",
          commandId: commandId(),
          threadId: sourceThreadId,
          projectId: thread.projectId,
          snapshotSequence: snapshot.snapshotSequence,
          expected: {
            workspaceRoot: snapshot.projects[0]!.workspaceRoot,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            linkedPullRequest: thread.linkedPullRequest ?? null,
            branchPullRequest: thread.branchPullRequest ?? null,
          },
          branchPullRequest:
            number === null
              ? null
              : {
                  projectId: thread.projectId,
                  repository: "owner/repo",
                  number,
                  url: `https://github.com/owner/repo/pull/${number}`,
                },
        }),
      );
    };
    const replay = async (epoch = 1) => {
      const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      for (const event of page.events) {
        const command = mapNativeThreadEvent(sourceThreadId, threadId, event, epoch);
        if (command) await central.run(central.engine.dispatch(command));
      }
    };
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
          type: "thread.pull-request.link",
          commandId: commandId(),
          threadId,
          host: "github.com",
          repository: "owner/other",
          number: 99,
          url: "https://github.com/owner/other/pull/99",
          source: "manual",
        }),
      );
      const canonicalUpdatedAt = (await current()).updatedAt;
      await updateBranch("main");
      await replay();
      expect(await current()).toMatchObject({
        branch: "main",
        title: "Thread",
        worktreePath: null,
        updatedAt: canonicalUpdatedAt,
      });
      await updateBranch("feature/new-during-run");
      await discover(42);
      await replay();
      const recorded = await current();
      expect(recorded.branchPullRequest).toEqual({
        projectId: ProjectId.make(`project:${threadId}`),
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      });
      expect(recorded.pullRequests.map((link) => link.number)).toEqual([99]);
      const sequence = (await central.readModel()).snapshotSequence;
      await replay();
      expect((await central.readModel()).snapshotSequence).toBe(sequence);

      // Enforce the metadata boundary even when an importer bypasses the mapper.
      const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      const metadata = page.events.find((event) => event.type === "thread.meta-updated")!;
      const mapped = mapNativeThreadEvent(sourceThreadId, threadId, metadata, 1)!;
      expect(mapped.event.type).toBe("thread.meta-updated");
      if (mapped.event.type !== "thread.meta-updated") throw new Error("Expected metadata");
      await expect(
        central.run(
          central.engine.dispatch({
            ...mapped,
            commandId: commandId(),
            event: {
              ...mapped.event,
              eventId: EventId.make(NodeCrypto.randomUUID()),
              payload: { ...mapped.event.payload, title: "Must not import" },
            },
          }),
        ),
      ).rejects.toThrow("Native replication may only apply");

      await central.run(
        bindNativeThreadStream({
          threadId,
          sourceThreadId,
          epoch: 2,
          sourceSequence: page.next,
          checkpointOffset: 0,
        }),
      );
      await updateBranch("feature/second");
      await discover(43);
      await expect(replay(1)).rejects.toThrow("superseded");
      await replay(2);
      expect(await current()).toMatchObject({
        branch: "feature/second",
        branchPullRequest: { number: 43 },
      });
      await updateBranch(null);
      await discover(null);
      await replay(2);
      expect(await current()).toMatchObject({ branch: null, branchPullRequest: null });
      expect((await current()).pullRequests.map((link) => link.number)).toEqual([99]);
      await updateBranch("feature/saved");
      await discover(44);
      await replay(2);
      await source.dispose();
      expect(await current()).toMatchObject({
        branch: "feature/saved",
        branchPullRequest: { number: 44 },
      });
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });

  it("keeps hosted PR tools and browser edits on the canonical thread, across retries and worker loss", async () => {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const otherThreadId = ThreadId.make(NodeCrypto.randomUUID());
    const source = await createOrchestrationSystem();
    const central = await createOrchestrationSystem(true);
    const receiver = HttpRouter.toWebHandler(
      hostedPullRequestRoutes.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, central.engine)),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, central.snapshotQuery)),
        Layer.provideMerge(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    const workerEnvironment = pullRequestAccessProjection({
      COMPADRE_CANONICAL_THREAD_ID: threadId,
      COMPADRE_API_KEY: "test-pr-key",
      COMPADRE_PUBLIC_URL: "https://controller.test",
    });
    const request = (body: unknown, token = workerEnvironment.COMPADRE_PULL_REQUESTS_TOKEN!) =>
      receiver.handler(
        new Request("https://central.test/api/compadre/pull-requests", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const target = { host: "github.com", repository: "example/repo", number: 42 };
    const url = "https://github.com/example/repo/pull/42";
    try {
      await seed(source, sourceThreadId);
      await seed(central, threadId);
      await seed(central, otherThreadId);
      vi.stubEnv("COMPADRE_API_KEY", "test-pr-key");
      vi.stubEnv("COMPADRE_CANONICAL_THREAD_ID", threadId);
      for (const [key, value] of Object.entries(workerEnvironment)) vi.stubEnv(key, value);
      const dependencies = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, source.engine),
        Layer.succeed(ProjectionSnapshotQuery, source.snapshotQuery),
        NodeServices.layer,
      );
      const toolkit = await source.run(
        PullRequestsToolkit.pipe(
          Effect.provide(PullRequestsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
        ),
      );
      const call = (name: keyof typeof PullRequestsToolkit.tools, params: PullRequestTargetInput) =>
        source.run(
          toolkit.handle(name, params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((results) => results.at(-1)!.result),
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("worker"),
              threadId: sourceThreadId,
              providerSessionId: "worker-session",
              providerInstanceId: ProviderInstanceId.make("codex"),
              issuedAt: 1,
              capabilities: new Set(["pull-requests"] as const),
            }),
            Effect.provide(dependencies),
          ),
        );
      let centralAvailable = true;
      vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
        if (!centralAvailable) return new Response(null, { status: 503 });
        const forwarded = new Request(input.toString(), init);
        expect(forwarded.url).toBe(workerEnvironment.COMPADRE_PULL_REQUESTS_URL);
        return forwardPullRequestRequest({
          authorization: forwarded.headers.get("authorization")!,
          body: await forwarded.json(),
          environment: { COMPADRE_T3_CENTRAL_URL: "https://central.test" },
          fetch: (url, init) => receiver.handler(new Request(url.toString(), init)),
        });
      });
      expect(await call("link_pull_request", { url })).toMatchObject({
        ...target,
        alreadyLinked: false,
      });
      expect(await call("link_pull_request", { url })).toMatchObject({ alreadyLinked: true });
      expect((await source.readModel()).threads[0]?.pullRequests).toEqual([]);
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === threadId)?.pullRequests,
      ).toMatchObject([{ ...target, source: "agent" }]);
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === otherThreadId)
          ?.pullRequests,
      ).toEqual([]);

      // Additional repositories and server-maintained review state use the same collection.
      const otherUrl = "https://github.com/example/other/pull/7";
      await call("link_pull_request", { url: otherUrl });
      await central.run(
        central.engine.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make("pr-state-sync"),
          threadId,
          ...target,
          stack: null,
          snapshot: {
            state: "open",
            title: "Shared review",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: createdAt,
            syncedAt: createdAt,
          },
        }),
      );
      expect(await call("list_thread_pull_requests", {})).toMatchObject({
        pullRequests: expect.arrayContaining([
          {
            ...target,
            url,
            source: "agent",
            state: "open",
            title: "Shared review",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            stack: null,
          },
          expect.objectContaining({ repository: "example/other", number: 7 }),
        ]),
      });
      await call("unlink_pull_request", { url: otherUrl });

      // This is the command issued by the browser; the next agent read must see it immediately.
      await central.run(
        central.engine.dispatch({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("browser-unlink"),
          threadId,
          ...target,
        }),
      );
      expect(await call("list_thread_pull_requests", {})).toEqual({ pullRequests: [], chains: [] });
      expect(await call("unlink_pull_request", { url })).toMatchObject({ wasLinked: false });
      await central.run(
        central.engine.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make("browser-link"),
          threadId,
          ...target,
          url,
          source: "manual",
        }),
      );
      expect(await call("list_thread_pull_requests", {})).toMatchObject({
        pullRequests: [{ ...target, source: "manual" }],
      });
      expect(await call("unlink_pull_request", { url })).toMatchObject({ wasLinked: true });
      expect(await call("list_thread_pull_requests", {})).toEqual({ pullRequests: [], chains: [] });

      centralAvailable = false;
      await expect(call("link_pull_request", { url })).rejects.toThrow("Could not link");
      expect((await source.readModel()).threads[0]?.pullRequests).toEqual([]);
      vi.stubEnv("COMPADRE_PULL_REQUESTS_TOKEN", "");
      await expect(call("link_pull_request", { url })).rejects.toThrow("Could not link");

      // The credential, not a caller-supplied thread ID, selects the canonical record.
      expect(
        (await request({ operation: "link", input: { url }, threadId: otherThreadId })).status,
      ).toBe(200);
      expect((await request({ operation: "list" }, "wrong-token")).status).toBe(401);
      const token = workerEnvironment.COMPADRE_PULL_REQUESTS_TOKEN!;
      const [payload, signature] = token.split(".");
      const changedThread = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
          threadId: otherThreadId,
        }),
      ).toString("base64url");
      expect((await request({ operation: "list" }, `${changedThread}.${signature}`)).status).toBe(
        401,
      );
      const expired = pullRequestAccessProjection(
        {
          COMPADRE_CANONICAL_THREAD_ID: threadId,
          COMPADRE_API_KEY: "test-pr-key",
          COMPADRE_PUBLIC_URL: "https://controller.test",
        },
        () => 0,
      );
      expect(
        (await request({ operation: "list" }, expired.COMPADRE_PULL_REQUESTS_TOKEN)).status,
      ).toBe(401);
      expect((await request({ operation: "delete-thread" })).status).toBe(400);
      expect(
        await (await request({ operation: "link", input: { url: "not-a-pr" } })).json(),
      ).toMatchObject({ error: expect.stringContaining("not a recognised") });
      await source.dispose();
      expect(await (await request({ operation: "list" })).json()).toMatchObject({
        result: { pullRequests: [{ ...target }] },
      });
      expect(
        (await central.readModel()).threads.find((thread) => thread.id === otherThreadId)
          ?.pullRequests,
      ).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await receiver.dispose();
      await source.dispose();
      await central.dispose();
    }
  });

  it("preserves upstream compaction counts and summary through central storage and replay", async () => {
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
      const [activity] = runtimeEventToActivities({
        type: "thread.state.changed",
        eventId: EventId.make("compacted"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId: sourceThreadId,
        turnId: TurnId.make("compact-turn"),
        createdAt,
        payload: { state: "compacted", beforeTokens: 60_877, afterTokens: 9_651 },
      });
      if (!activity) throw new Error("Missing compaction activity");
      await source.run(
        source.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("compact-activity"),
          threadId: sourceThreadId,
          activity,
          createdAt,
        }),
      );
      const page = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      for (const event of page.events) {
        const command = mapNativeThreadEvent(sourceThreadId, threadId, event, 1);
        if (!command) continue;
        await central.run(central.engine.dispatch(command));
        await central.run(central.engine.dispatch(command));
      }
      const snapshot = await central.readModel();
      const activities = snapshot.threads.find((thread) => thread.id === threadId)?.activities;
      expect(activities).toHaveLength(1);
      expect(activities?.[0]).toMatchObject({
        summary: "Compacted context 60.9K → 9.65K tokens",
        kind: "context-compaction",
        payload: { state: "compacted", beforeTokens: 60_877, afterTokens: 9_651 },
        turnId: nativeId(sourceThreadId, "compact-turn"),
      });
    } finally {
      await source.dispose();
      await central.dispose();
    }
  });

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

  it.each([null, "Worker stopped during the run", "Failed to restore workspace"])(
    "worker closure preserves error %s and cannot stop a newer claim",
    async (lastError) => {
      const central = await createOrchestrationSystem(true);
      const threadId = ThreadId.make(NodeCrypto.randomUUID());
      const sourceThreadId = ThreadId.make(NodeCrypto.randomUUID());
      try {
        await seed(central, threadId);
        await central.run(
          central.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            session: {
              threadId,
              status: lastError ? "error" : "ready",
              activeTurnId: null,
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              lastError,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
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
        expect(after.threads.find((thread) => thread.id === threadId)?.session?.lastError).toBe(
          lastError,
        );
        const sequence = after.snapshotSequence;
        await central.run(central.engine.dispatch({ ...command, epoch: 2 }));
        expect((await central.readModel()).snapshotSequence).toBe(sequence);
        await central.run(
          central.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        await central.run(
          central.engine.dispatch({
            ...command,
            epoch: 2,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            status: "error",
            reason: "Event delivery blocked; pending output retained",
          }),
        );
        const blocked = (await central.readModel()).threads.find(
          (thread) => thread.id === threadId,
        )?.session;
        expect(blocked?.status).toBe("error");
        expect(blocked?.activeTurnId).toBeNull();
        expect(blocked?.lastError).toBe("Event delivery blocked; pending output retained");
        await central.run(
          central.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        await central.run(
          central.engine.dispatch({
            ...command,
            epoch: 2,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            status: "error",
          }),
        );
        expect(
          (await central.readModel()).threads.find((thread) => thread.id === threadId)?.session
            ?.status,
        ).toBe("ready");
      } finally {
        await central.dispose();
      }
    },
  );

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
        Layer.merge(nativeThreadEventRoutes, providerActionRoutes).pipe(
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
      const actionUrl = "http://localhost/api/compadre/provider-actions";
      expect((await worker.handler(new Request(actionUrl))).status).toBe(401);
      expect(
        (
          await worker.handler(
            new Request(actionUrl, { headers: { authorization: "Bearer worker-test" } }),
          )
        ).status,
      ).toBe(403);
      const capabilities = await worker.handler(
        new Request(actionUrl, { headers: { authorization: "Bearer worker-writer" } }),
      );
      expect(await capabilities.json()).toEqual({ version: 1, actions: ["compact"] });
      const actionCommand = {
        type: "thread.turn.start",
        commandId: "compact-action",
        threadId: sourceThreadId,
        providerAction: { type: "compact" },
        message: {
          messageId: "compact-action-message",
          role: "user",
          text: "/compact",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      };
      const sendAction = (command: unknown, token = "worker-writer") =>
        worker.handler(
          new Request(actionUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(command),
          }),
        );
      expect((await sendAction(actionCommand, "worker-test")).status).toBe(403);
      expect(
        (await sendAction({ ...actionCommand, providerAction: { type: "unknown" } })).status,
      ).toBe(400);
      expect((await sendAction({ ...actionCommand, providerAction: undefined })).status).toBe(400);
      const dispatched = await sendAction(actionCommand);
      expect(dispatched.status).toBe(200);
      expect(await (await sendAction(actionCommand)).json()).toEqual(await dispatched.json());
      const actionPage = await source.run(readNativeEventPage(source.engine, sourceThreadId, 0));
      const actionEvent = actionPage.events.find(
        (event) => event.type === "thread.turn-start-requested",
      );
      expect(
        actionEvent?.type === "thread.turn-start-requested" && actionEvent.payload.providerAction,
      ).toEqual({ type: "compact" });
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
      expect(page.headers.get("stream-next-offset")).toBe("00000000000000000006");
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
      expect(head.headers.get("stream-next-offset")).toBe("00000000000000000006");
      const waiting = worker.handler(
        new Request(
          `${url}?threadId=${sourceThreadId}&offset=00000000000000000006&live=long-poll`,
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
