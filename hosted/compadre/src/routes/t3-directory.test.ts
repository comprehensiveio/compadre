import { memoryPersistence } from "@tanstack/ai-persistence";
import { NativeT3RunRequestStore, type NativeT3RunRequest } from "../t3/run-request-store.js";
import { driveNativeT3Run } from "../t3/native-t3-run-driver.js";
import { T3Client } from "../t3/client.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type { T3ThreadSnapshot } from "../t3/client.js";
import type { T3GatewayTurn } from "../t3/gateway.js";
import type { T3ArtifactStore } from "../t3/artifact-store.js";
import { createAgentRunDurability } from "../durability/runtime.js";
import { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import {
  TemporalNativeT3RunService,
  type NativeT3RunService,
} from "../t3/run-service.js";
import {
  createT3DirectoryRoutes,
  isSlackOwnedNativeT3Run,
  shouldMirrorNativeT3RunToSlack,
  withTrustedRequesterContext,
  type T3DirectoryRoutesDependencies,
} from "./t3-directory.js";

test("adds trusted requester identity to provider context without changing unknown callers", () => {
  const prompt = withTrustedRequesterContext("Fix the issue", {
    userId: "user-1",
    displayName: "Isaac Sherrill",
    origin: "slack",
    slack: {
      workspaceId: "T1",
      userId: "U1",
      channelId: "C1",
      messageTs: "1.2",
      threadTs: "1.0",
    },
  });
  assert.match(prompt, /Compadre trusted request metadata/);
  assert.match(prompt, /"displayName":"Isaac Sherrill"/);
  assert.match(prompt, /"origin":"slack"/);
  assert.match(prompt, /\n\nFix the issue$/);
  assert.equal(withTrustedRequesterContext("Fix the issue", null), "Fix the issue");
});

test("leaves Slack-originated final delivery to the controller outbox", () => {
  assert.equal(
    shouldMirrorNativeT3RunToSlack({
      attribution: {
        userId: "slack:T1:U1",
        displayName: "Isaac Sherrill",
        origin: "slack",
      },
    }),
    false,
    "trusted Slack attribution remains authoritative when an adapter drops the message id",
  );
  assert.equal(
    shouldMirrorNativeT3RunToSlack({
      messageId: "slack-entrypoint:legacy-message",
    }),
    false,
    "the historical message-id marker remains a fallback",
  );
  assert.equal(
    shouldMirrorNativeT3RunToSlack({
      messageId: "slack-entrypoint:stale-adapter-message",
      attribution: {
        userId: "slack:T1:U1",
        displayName: "Isaac Sherrill",
        origin: "web",
      },
    }),
    true,
    "trusted web attribution takes precedence over a stale legacy message prefix",
  );
});

test("triggered prompts are neither mirrored nor Slack-owned", () => {
  const attribution = {
    userId: "trigger:trigger-1",
    displayName: "Daily summary",
    origin: "trigger",
    trigger: {
      triggerId: "trigger-1",
      name: "Daily summary",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
    },
  };
  // The mirror would post the prompt to Slack; the trigger delivery layer
  // owns the answer instead, and no binding is required to dispatch.
  assert.equal(
    shouldMirrorNativeT3RunToSlack({
      messageId: "slack-entrypoint:trigger-turn",
      attribution,
    }),
    false,
  );
  assert.equal(
    isSlackOwnedNativeT3Run({
      messageId: "slack-entrypoint:trigger-turn",
      attribution,
    }),
    false,
  );
  // Trigger metadata never reaches the agent prompt.
  assert.equal(
    withTrustedRequesterContext("Fix the issue", attribution),
    "Fix the issue",
  );
});

const binding: T3ThreadBinding = {
  canonicalThreadId: "thread-1",
  providerInstanceId: "codex",
  t3ThreadId: "native-thread-1",
  projectId: "project-1",
  sandboxId: "sandbox-secret",
  baseUrl: "https://sandbox.example",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  title: "Investigate the thing",
  status: "working",
  createdAt: "2026-08-26T15:00:00.000Z",
  updatedAt: "2026-08-26T15:00:01.000Z",
};

const snapshot: T3ThreadSnapshot = {
  snapshotSequence: 4,
  thread: {
    id: "native-thread-1",
    projectId: "project-1",
    title: "Investigate the thing",
    modelSelection: binding.modelSelection,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-08-26T15:00:01.000Z",
      startedAt: "2026-08-26T15:00:01.000Z",
      completedAt: "2026-08-26T15:00:02.000Z",
      assistantMessageId: "assistant-1",
    },
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "Done",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-26T15:00:02.000Z",
        updatedAt: "2026-08-26T15:00:02.000Z",
      },
    ],
    session: { status: "ready", activeTurnId: null, lastError: null },
  },
};

function authorized(body?: unknown): RequestInit {
  return {
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Authorization: "Bearer test-key",
      "x-compadre-native-delivery": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  };
}

test("accepts authenticated run steering and reports closed runs", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  const calls: Array<{ runId: string; id: string; text: string }> = [];
  let accepted = true;
  const service = {
    async steer(runId: string, input: { id: string; text: string }) {
      calls.push({ runId, ...input });
      return accepted;
    },
  } as unknown as NativeT3RunService;
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => "generated",
    getGateway: async () => null,
    getRunService: async () => service,
    watchTurn() {},
  }));
  const path = "/hosted/t3/runs/run-1/steer";

  assert.equal((await app.request(path, { method: "POST" })).status, 401);
  assert.equal(
    (await app.request(path, authorized({ id: "", text: "focus" }))).status,
    400,
  );
  const response = await app.request(
    path,
    authorized({ id: "instruction-1", text: "focus on cancellation" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(calls, [{
    runId: "run-1",
    id: "instruction-1",
    text: "focus on cancellation",
  }]);

  accepted = false;
  assert.equal(
    (await app.request(
      path,
      authorized({ id: "instruction-2", text: "too late" }),
    )).status,
    409,
  );
});

test("serves discovered models only after authentication and without waking workers", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  let discoveries = 0;
  const app = createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => { throw new Error("must not create a thread"); },
    getGateway: async () => { throw new Error("must not acquire a worker"); },
    watchTurn: () => { throw new Error("must not start a turn"); },
    discoverCodexModels: async () => {
      discoveries++;
      return { version: "1.0.0", data: [{ model: "future-model" }], nextCursor: null };
    },
  });
  const path = "/hosted/t3/providers/codex/models";
  assert.equal((await app.request(path)).status, 401);
  assert.equal(discoveries, 0);
  const response = await app.request(path, authorized());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ model: "future-model" }]);
  assert.equal(discoveries, 1);
  assert.equal((await app.request("/hosted/t3/providers/claude-code/models", authorized())).status, 200);
  assert.equal((await app.request("/hosted/t3/providers/unknown/models", authorized())).status, 400);
});

test("lists directory metadata without waking a T3 sandbox", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  let reconnects = 0;
  const dependencies: T3DirectoryRoutesDependencies = {
    enabled: () => true,
    createId: () => "generated-thread",
    watchTurn() {},
    async getGateway() {
      return {
        async list() {
          return [binding];
        },
        async send() {
          throw new Error("unused");
        },
        async snapshot() {
          reconnects += 1;
          throw new Error("unused");
        },
        async open() {
          reconnects += 1;
          throw new Error("unused");
        },
        async cancel() {
          reconnects += 1;
          throw new Error("unused");
        },
        async waitForTerminal() {
          throw new Error("unused");
        },
      };
    },
  };
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes(dependencies));
  const response = await app.request("/hosted/t3/threads", authorized());

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    threads: Array<Record<string, unknown>>;
  };
  assert.equal(reconnects, 0);
  assert.equal(body.threads[0]?.canonicalThreadId, "thread-1");
  assert.equal(body.threads[0]?.sandboxId, undefined);
  assert.equal(body.threads[0]?.baseUrl, undefined);
});

test("serves a durable artifact only through the authenticated controller route", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  const artifactId = "a".repeat(64);
  const artifacts = {
    async read(runId: string, requestedArtifactId: string) {
      assert.equal(runId, "run-1");
      assert.equal(requestedArtifactId, artifactId);
      return {
        metadata: {
          runId,
          artifactId,
          objectKey: `attachments/v1/run/${artifactId}`,
          path: "proof.png",
          name: "proof.png",
          title: "Proof",
          mimetype: "image/png",
          sizeBytes: 3,
          createdAt: "2026-08-26T15:00:00.000Z",
        },
        bytes: Uint8Array.from([1, 2, 3]),
      };
    },
  } as unknown as T3ArtifactStore;
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => "generated",
    getGateway: async () => null,
    getArtifactStore: async () => artifacts,
    watchTurn() {},
  }));
  const path = `/hosted/t3/artifacts?runId=run-1&artifactId=${artifactId}`;

  assert.equal((await app.request(path)).status, 401);
  const response = await app.request(path, authorized());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1, 2, 3]));
});

test("creates, reads, sends, opens, and cancels one native T3 thread", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const sends: Array<{ id: string; text: string }> = [];
  const watched: T3GatewayTurn[] = [];
  const gateway = {
    async list() {
      return [binding];
    },
    async send(input: {
      canonicalThreadId: string;
      text: string;
    }): Promise<T3GatewayTurn> {
      sends.push({ id: input.canonicalThreadId, text: input.text });
      return {
        binding: { ...binding, canonicalThreadId: input.canonicalThreadId },
        dispatch: {
          sequence: 3,
          commandId: "command-1",
          messageId: "message-1",
          threadId: "native-thread-1",
          createdAt: "2026-08-26T15:00:01.000Z",
        },
      };
    },
    async snapshot() {
      return {
        binding: { ...binding, status: "ready" as const },
        snapshot,
        source: "central" as const,
      };
    },
    async open() {
      return { binding, pairingUrl: "https://sandbox.example/pair#token=one-time" };
    },
    async cancel() {
      return 7;
    },
    async waitForTerminal() {
      return snapshot;
    },
  };
  const app = new Hono();
  app.route(
    "/",
    createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => "generated-thread",
      getGateway: async () => gateway,
      watchTurn(_gateway, turn) {
        watched.push(turn);
      },
    }),
  );

  const created = await app.request(
    "/hosted/t3/threads",
    authorized({
      title: "New work",
      text: "first",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );
  assert.equal(created.status, 202, await created.clone().text());
  assert.deepEqual(sends[0], { id: "generated-thread", text: "first" });

  const sent = await app.request(
    "/hosted/t3/threads/codex/thread-1/messages",
    authorized({
      text: "second",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );
  assert.equal(sent.status, 202, await sent.clone().text());
  assert.deepEqual(sends[1], { id: "thread-1", text: "second" });
  assert.equal(watched.length, 2);

  const read = await app.request(
    "/hosted/t3/threads/codex/thread-1/snapshot",
    authorized(),
  );
  assert.equal(read.status, 200);
  const readBody = (await read.json()) as {
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  };
  assert.equal(readBody.snapshot.thread.messages[0]?.text, "Done");
  assert.equal(readBody.source, "central");

  const opened = await app.request(
    "/hosted/t3/threads/codex/thread-1/open",
    authorized({}),
  );
  assert.equal(opened.status, 200);
  assert.equal(
    ((await opened.json()) as { pairingUrl: string }).pairingUrl,
    "https://sandbox.example/pair#token=one-time",
  );

  const cancelled = await app.request(
    "/hosted/t3/threads/codex/thread-1/cancel",
    authorized({}),
  );
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, sequence: 7 });
});

test("generates hidden provider text without creating a directory thread", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  let received: unknown;
  let sends = 0;
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => "generated",
    watchTurn() {},
    async getGateway() {
      return {
        async list() { return []; },
        async generateText(input) {
          received = input;
          return {
            dispatch: {
              sequence: 3,
              commandId: "command-generate",
              messageId: "message-generate",
              threadId: "native-generation-thread",
              createdAt: "2026-08-27T15:00:00.000Z",
            },
            snapshot: {
              snapshotSequence: 5,
              thread: {
                id: "native-generation-thread",
                projectId: "project-1",
                title: "Internal text generation",
                modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
                latestTurn: {
                  turnId: "turn-generate",
                  state: "completed" as const,
                  requestedAt: "2026-08-27T15:00:00.000Z",
                  startedAt: "2026-08-27T15:00:00.000Z",
                  completedAt: "2026-08-27T15:00:01.000Z",
                  assistantMessageId: "assistant-generate",
                },
                messages: [
                  {
                    id: "message-generate",
                    role: "user" as const,
                    text: "Generate a title",
                    turnId: "turn-generate",
                    streaming: false,
                    createdAt: "2026-08-27T15:00:00.000Z",
                    updatedAt: "2026-08-27T15:00:00.000Z",
                  },
                  {
                    id: "assistant-generate",
                    role: "assistant" as const,
                    text: '{"title":"Generated title"}',
                    turnId: "turn-generate",
                    streaming: false,
                    createdAt: "2026-08-27T15:00:01.000Z",
                    updatedAt: "2026-08-27T15:00:01.000Z",
                  },
                ],
                session: { status: "ready" as const, activeTurnId: null, lastError: null },
              },
            },
          };
        },
        async send() {
          sends += 1;
          throw new Error("user-visible send must not run");
        },
        async snapshot() { return null; },
        async open() { return null; },
        async cancel() { return null; },
        async waitForTerminal() { throw new Error("unused"); },
      };
    },
  }));

  const response = await app.request(
    "/hosted/t3/text-generation",
    authorized({
      prompt: "Generate a title",
      provider: "codex",
      model: "gpt-5.6-luna",
      modelOptions: [{ id: "reasoningEffort", value: "low" }],
    }),
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { result: '{"title":"Generated title"}' });
  assert.equal(sends, 0);
  assert.deepEqual(
    (received as { modelSelection: unknown }).modelSelection,
    {
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
  );
});

test("streams a native Modal T3 turn through the central provider endpoint", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  let selection: unknown;
  let inputFiles: unknown;
  let sends = 0;
  const blockedSlackDestinations: unknown[] = [];
  let linkedSlackBinding: {
    channelId: string;
    threadTs: string;
  } | null = null;
  const turnSnapshot: T3ThreadSnapshot = {
    ...snapshot,
    snapshotSequence: 9,
    thread: {
      ...snapshot.thread,
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "run pwd",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-26T15:00:01.000Z",
          updatedAt: "2026-08-26T15:00:01.000Z",
        },
        ...snapshot.thread.messages,
      ],
      activities: [
        {
          id: "usage-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          createdAt: "2026-08-26T15:00:01.250Z",
          payload: {
            usedTokens: 15,
            lastInputTokens: 10,
            lastOutputTokens: 5,
          },
        },
        {
          id: "tool-complete",
          kind: "tool.completed",
          turnId: "turn-1",
          summary: "Command run",
          createdAt: "2026-08-26T15:00:01.500Z",
          payload: {
            toolCallId: "tool-1",
            detail: "Bash: pwd",
            status: "completed",
            data: { command: "pwd" },
          },
        },
      ],
    },
  };
  const gateway = {
    async list() { return []; },
    async send(input: {
      modelSelection: unknown;
      inputFiles?: unknown;
      blockedSlackDestination?: unknown;
    }): Promise<T3GatewayTurn> {
      sends += 1;
      selection = input.modelSelection;
      inputFiles = input.inputFiles;
      blockedSlackDestinations.push(input.blockedSlackDestination);
      return {
        binding: { ...binding, status: "working" as const },
        dispatch: {
          sequence: 3,
          commandId: "command-1",
          messageId: "message-1",
          threadId: "native-thread-1",
          createdAt: "2026-08-26T15:00:01.000Z",
        },
      };
    },
    async snapshot() { return null; },
    async open() { return null; },
    async cancel() { return 7; },
    async waitForTerminal(input: {
      onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
    }) {
      await input.onSnapshot?.(turnSnapshot);
      return turnSnapshot;
    },
  };
  const slackBindingLookups: string[] = [];
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const runCoordinator = new NativeT3RunCoordinator(durability);
  const inputObjects = new Map<string, Uint8Array>();
  const requests = new NativeT3RunRequestStore(memoryPersistence().stores.metadata, {
    async put({ key, bytes }) { inputObjects.set(key, bytes); },
    async get(key) { const bytes = inputObjects.get(key); assert.ok(bytes); return bytes; },
  });
  t.after(() => durability.close());
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => "generated",
    getGateway: async () => gateway,
    getRunCoordinator: async () => runCoordinator,
    getRunService: async () => new TemporalNativeT3RunService(runCoordinator, requests, {
      async start({ input }) {
        await driveNativeT3Run({ durability, requests, prepareNativeDelivery: async () => {}, gateway: {
          ...gateway, resumeTurn: async () => null,
        } }, input.runId);
        return { started: true };
      },
      cancel: async () => true, steer: async () => true,
    }),
    watchTurn() {},
    async getSlackBinding(threadId) {
      slackBindingLookups.push(threadId);
      return linkedSlackBinding;
    },
  }));
  const response = await app.request("/hosted/t3/chat", authorized({
    threadId: "central-thread",
    runId: "run-1",
    messages: [{ id: "input-1", role: "user", content: "run pwd" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {
      provider: "claude-code",
      model: "claude-sonnet-5",
      modelOptions: [{ id: "effort", value: "high" }],
      inputFiles: [
        {
          name: "screen.png",
          mimetype: "image/png",
          sizeBytes: 3,
          dataBase64: "AQID",
        },
      ],
    },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(response.headers.get("x-compadre-t3-protocol-version"), "2");
  const body = await response.text();
  assert.match(body, /"type":"RUN_STARTED"/);
  assert.doesNotMatch(body, /"type":"TOOL_CALL_START"/);
  assert.doesNotMatch(body, /"type":"THREAD_TOKEN_USAGE_UPDATED"/);

  assert.doesNotMatch(body, /"type":"TEXT_MESSAGE_CONTENT"/);
  assert.match(body, /"type":"RUN_FINISHED"/);
  assert.match(body, /"protocolVersion":2/);
  assert.deepEqual(selection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "effort", value: "high" }],
  });
  assert.deepEqual(inputFiles, [
    {
      name: "screen.png",
      mimetype: "image/png",
      sizeBytes: 3,
      dataBase64: "AQID",
    },
  ]);
  assert.deepEqual(slackBindingLookups, ["central-thread"]);
  assert.equal(sends, 1);

  const replay = await app.request(
    "/hosted/t3/runs/run-1/events?offset=-1",
    authorized(),
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(await replay.text(), body);

  const repeated = await app.request("/hosted/t3/chat", authorized({
    threadId: "central-thread",
    runId: "run-1",
    messages: [{ id: "input-1", role: "user", content: "run pwd" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { provider: "claude-code", model: "claude-sonnet-5" },
  }));
  assert.equal(repeated.status, 200, await repeated.clone().text());
  assert.equal(await repeated.text(), body);
  assert.equal(sends, 1);

  const slackResponse = await app.request("/hosted/t3/chat", authorized({
    threadId: "central-thread",
    runId: "run-from-slack",
    messages: [{
      id: "slack-entrypoint:message-2",
      role: "user",
      content: "continue from Slack",
    }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { provider: "claude-code", model: "claude-sonnet-5" },
  }));
  assert.equal(slackResponse.status, 409, await slackResponse.clone().text());
  assert.deepEqual(await slackResponse.json(), {
    error: "Slack-originated turns require a durable thread binding",
  });
  assert.deepEqual(slackBindingLookups, [
    "central-thread",
    "central-thread",
    "central-thread",
  ]);
  assert.equal(sends, 1);

  linkedSlackBinding = { channelId: "C1", threadTs: "1.0" };
  const boundSlackResponse = await app.request(
    "/hosted/t3/chat",
    authorized({
      threadId: "central-thread",
      runId: "run-from-bound-slack",
      messages: [
        {
          id: "slack-entrypoint:message-3",
          role: "user",
          content: "continue from bound Slack",
        },
      ],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { provider: "claude-code", model: "claude-sonnet-5" },
    }),
  );
  assert.equal(
    boundSlackResponse.status,
    200,
    await boundSlackResponse.clone().text(),
  );
  await boundSlackResponse.text();
  assert.equal(sends, 2);
  assert.deepEqual(blockedSlackDestinations, [
    undefined,
    { channelId: "C1", threadTs: "1.0" },
  ]);
});

test("provider actions survive durable dispatch without prompt decorations or delivery side effects", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  const durability = await createAgentRunDurability({ COMPADRE_DURABILITY_BACKEND: "memory" });
  assert.ok(durability);
  t.after(() => durability.close());
  const requests = new NativeT3RunRequestStore(memoryPersistence().stores.metadata);
  const sent: unknown[] = [];
  const gateway = {
    async list() { return []; }, async snapshot() { return null; }, async open() { return null; }, async cancel() { return 0; },
    async resumeTurn() { return null; },
    async send(input: unknown) {
      sent.push(input);
      return { binding, dispatch: { sequence: 1, commandId: "command-1", messageId: "input-1", threadId: "native-thread-1", createdAt: "2026-08-26T15:00:01.000Z" } };
    },
    async waitForTerminal() { return { ...snapshot, thread: { ...snapshot.thread, messages: [{ id: "input-1", role: "user" as const, text: "/compact", turnId: "turn-1", streaming: false, createdAt: "2026-08-26T15:00:01.000Z", updatedAt: "2026-08-26T15:00:01.000Z" }, ...snapshot.thread.messages] } }; },
  };
  const service = new TemporalNativeT3RunService(new NativeT3RunCoordinator(durability), requests, {
    async start({ input }) {
      await driveNativeT3Run({ durability, requests, gateway, prepareNativeDelivery: async () => {} }, input.runId);
      return { started: true };
    },
    cancel: async () => true, steer: async () => { throw new Error("Actions must not accept steering"); },
  });
  const app = createT3DirectoryRoutes({
    enabled: () => true, createId: () => "generated", getGateway: async () => gateway,
    getRunService: async () => service, watchTurn() {},
    getArtifactStore: async () => ({} as T3ArtifactStore),
    getSlackBinding: async () => ({ channelId: "C1", threadTs: "1.0" }),
  });
  const body = (runId: string, forwarded: Record<string, unknown> = {}) => ({
    threadId: "central-thread", runId,
    messages: [{ id: "input-1", role: "user", content: "/compact" }], tools: [], context: [], state: {},
    forwardedProps: { provider: "claude-code", attribution: { userId: "user-1", displayName: "Isaac", origin: "web" }, ...forwarded },
  });
  for (const [index, path] of ["/hosted/t3/actions", "/hosted/t3/chat"].entries()) {
    const runId = `compact-${index}`;
    const response = await app.request(path, authorized(body(runId, index === 0 ? { providerAction: { type: "compact" } } : {})));
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /RUN_FINISHED/);
    const request = await requests.getRequest(runId);
    assert.ok(request);
    assert.equal(request.text, "/compact");
    assert.deepEqual(request.providerAction, { type: "compact" });
    assert.equal(request.collectArtifacts, false);
    assert.equal(request.slackMirror, undefined);
    assert.equal(request.slackArtifactDestination, undefined);
  }
  assert.equal(sent.length, 2);
  for (const input of sent) {
    assert.deepEqual((input as NativeT3RunRequest).providerAction, { type: "compact" });
    assert.equal((input as NativeT3RunRequest).text, "/compact");
  }
  for (const props of [{ providerAction: { type: "shell" } }, { provider: "codex" }, { inputFiles: [{ name: "x.txt", mimetype: "text/plain", sizeBytes: 1, dataBase64: "eA==" }] }]) {
    assert.equal((await app.request("/hosted/t3/actions", authorized(body("invalid", props)))).status, 400);
  }
  assert.equal(sent.length, 2);
  assert.equal(await service.steer("compact-0", { id: "steer", text: "continue" }), false);
});

test("rejects an unsupported native T3 protocol version before starting work", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });
  let gatewayLookups = 0;
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({
    enabled: () => true,
    createId: () => "generated",
    watchTurn() {},
    async getGateway() {
      gatewayLookups += 1;
      return null;
    },
  }));
  const init = authorized({
    messages: [{ id: "input", role: "user", content: "hello" }],
    forwardedProps: { provider: "codex" },
  });
  const response = await app.request("/hosted/t3/chat", {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      "X-Compadre-T3-Protocol-Version": "99",
    },
  });
  assert.equal(response.status, 409);
  assert.equal(gatewayLookups, 0);
});

test("does not expose Modal bootstrap details when provisioning fails", async (t) => {
  const previousApiKey = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previousApiKey;
  });

  const app = new Hono();
  app.route(
    "/",
    createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => "generated-thread",
      watchTurn() {},
      async getGateway() {
        return {
          async list() { return []; },
          async send() {
            throw new Error("git clone failed with private repository details");
          },
          async snapshot() { throw new Error("unused"); },
          async open() { throw new Error("unused"); },
          async cancel() { throw new Error("unused"); },
          async waitForTerminal() { throw new Error("unused"); },
        };
      },
    }),
  );
  const response = await app.request(
    "/hosted/t3/threads",
    authorized({
      title: "Probe",
      text: "hello",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
  );

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /T3 environment operation failed/);
  assert.doesNotMatch(body, /private repository details/);
});

test("native controls require authentication and the exact durable worker claim", async (t) => {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  t.after(() => { if (previous === undefined) delete process.env.COMPADRE_API_KEY; else process.env.COMPADRE_API_KEY = previous; });
  const commands: unknown[] = [];
  const client = new T3Client("https://worker.example", "unused");
  client.dispatch = async (command) => { commands.push(command); return 9; };
  const app = new Hono();
  app.route("/", createT3DirectoryRoutes({ enabled: () => true, createId: () => "unused", watchTurn() {},
    getNativeDelivery: async () => ({ get: async () => ({ version: 1, canonicalThreadId: "central", sourceThreadId: "worker",
      epoch: 2, sandboxId: "sandbox", offset: "00000000000000000003", startOffset: "00000000000000000000", checkpointOffset: 0 }) }),
    getGateway: async () => ({ list: async () => [], send: async () => { throw new Error("unused"); },
      snapshot: async () => null, open: async () => null, cancel: async () => null, waitForTerminal: async () => { throw new Error("unused"); },
      attachWorker: async () => ({ binding: { ...binding, canonicalThreadId: "central", t3ThreadId: "worker", sandboxId: "sandbox" }, environment: { sandboxId: "sandbox", projectId: "project", client } }),
    }),
  }));
  const body = { sourceThreadId: "worker", epoch: 2, commandId: "native-control:question", createdAt: "2026-09-10T00:00:00.000Z",
    type: "thread.user-input-response-requested", requestId: "compadre-native:worker:question", answers: { choice: "A" } };
  const url = "/hosted/t3/native-threads/central/control";
  assert.equal((await app.request(url, { method: "POST", body: JSON.stringify(body) })).status, 401);
  assert.equal((await app.request(url, authorized({ ...body, epoch: 1 }))).status, 409);
  assert.equal((await app.request(url, authorized({ ...body, requestId: "compadre-native:other:question" }))).status, 400);
  assert.equal((await app.request(url, authorized(body))).status, 200);
  assert.equal((await app.request(url, authorized({ ...body, commandId: "native-control:second-click" }))).status, 200);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], { type: "thread.user-input.respond", commandId: (commands[0] as { commandId: string }).commandId, threadId: "worker", createdAt: body.createdAt, requestId: "question", answers: body.answers });
  assert.deepEqual(commands[1], commands[0]);
});
