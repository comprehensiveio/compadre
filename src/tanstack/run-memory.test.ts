import assert from "node:assert/strict";
import test from "node:test";
import {
  EventType,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  type FinishInfo,
  type StreamChunk,
} from "@tanstack/ai";
import { memoryPersistence } from "@tanstack/ai-persistence";
import {
  buildRunMemoryDigest,
  defineRunMemoryStore,
  metadataRunMemoryStore,
  withRunMemory,
  type RunMemoryRecord,
  type RunMemoryStore,
  type WithRunMemoryOptions,
} from "./run-memory.js";

function inMemoryStore(): RunMemoryStore & {
  threads: Map<string, Array<RunMemoryRecord>>;
} {
  const threads = new Map<string, Array<RunMemoryRecord>>();
  return {
    threads,
    ...defineRunMemoryStore({
      async load(threadId) {
        return threads.get(threadId) ?? [];
      },
      async save(threadId, records) {
        threads.set(threadId, records);
      },
    }),
  };
}

function toolCallChunks(options: {
  toolCallId: string;
  name: string;
  input: unknown;
  result: string;
  startTimestamp?: number;
  resultTimestamp?: number;
  resultState?: "output-error";
}): Array<StreamChunk> {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: options.toolCallId,
      toolCallName: options.name,
      toolName: options.name,
      ...(options.startTimestamp !== undefined
        ? { timestamp: options.startTimestamp }
        : {}),
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: options.toolCallId,
      delta: JSON.stringify(options.input),
      args: JSON.stringify(options.input),
    },
    {
      type: EventType.TOOL_CALL_END,
      toolCallId: options.toolCallId,
      toolCallName: options.name,
      input: options.input,
    },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: options.toolCallId,
      messageId: `${options.toolCallId}-result`,
      content: options.result,
      ...(options.resultTimestamp !== undefined
        ? { timestamp: options.resultTimestamp }
        : {}),
      ...(options.resultState ? { state: options.resultState } : {}),
    },
  ];
}

async function simulateRun(options: {
  store: RunMemoryStore;
  middlewareOptions?: WithRunMemoryOptions;
  runId?: string;
  chunks?: Array<StreamChunk>;
  modelOptions?: Record<string, unknown>;
  terminal?: "finish" | "error" | "abort";
}): Promise<{ configPatch: Partial<ChatMiddlewareConfig> | void | null }> {
  const middleware = withRunMemory(options.store, {
    now: () => 1_000,
    ...options.middlewareOptions,
  });
  const ctx = {
    phase: "init",
    threadId: "thread",
    runId: options.runId ?? "run-1",
    provider: "claude-code",
    model: "claude-opus-5",
    modelOptions: options.modelOptions,
  } as ChatMiddlewareContext;
  await middleware.setup?.(ctx);
  const config: ChatMiddlewareConfig = {
    messages: [],
    systemPrompts: ["base prompt"],
    tools: [],
  };
  const configPatch = await middleware.onConfig?.(ctx, config);
  for (const chunk of options.chunks ?? []) {
    await middleware.onChunk?.(ctx, chunk);
  }
  const terminal = options.terminal ?? "finish";
  if (terminal === "finish") {
    await middleware.onFinish?.(ctx, {
      finishReason: "stop",
      duration: 1,
      content: "",
    } satisfies FinishInfo);
  } else if (terminal === "error") {
    await middleware.onError?.(ctx, { error: new Error("boom"), duration: 1 });
  } else {
    await middleware.onAbort?.(ctx, { duration: 1 });
  }
  return { configPatch };
}

test("records tool calls, reasoning, and session id from a harness run", async () => {
  const store = inMemoryStore();
  await simulateRun({
    store,
    chunks: [
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "run-1", timestamp: 100 },
      ...toolCallChunks({
        toolCallId: "call-1",
        name: "command_execution",
        input: { command: "ls" },
        result: '{"exit_code":0,"aggregated_output":"README.md"}',
        startTimestamp: 110,
        resultTimestamp: 150,
      }),
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "Listing files before answering.",
      },
      {
        type: EventType.CUSTOM,
        name: "codex.session-id",
        value: { sessionId: "session-9" },
      },
    ],
  });

  const records = store.threads.get("thread");
  assert.equal(records?.length, 1);
  const record = records[0]!;
  assert.equal(record.runId, "run-1");
  assert.equal(record.provider, "claude-code");
  assert.equal(record.status, "completed");
  assert.equal(record.sessionId, "session-9");
  assert.equal(record.startedAt, 100);
  assert.equal(record.reasoning, "Listing files before answering.");
  assert.equal(record.truncated, false);
  assert.deepEqual(record.tools, [
    {
      toolCallId: "call-1",
      name: "shell",
      rawName: "command_execution",
      args: '{"command":"ls"}',
      outcome: "ok",
      resultPreview: '{"exit_code":0,"aggregated_output":"README.md"}',
      startedAt: 110,
      durationMs: 40,
    },
  ]);
});

test("marks error and interrupted outcomes", async () => {
  const store = inMemoryStore();
  await simulateRun({
    store,
    chunks: [
      ...toolCallChunks({
        toolCallId: "call-error",
        name: "read_logs",
        input: {},
        result: "TypeError: cannot read logs",
        resultState: "output-error",
      }),
      ...toolCallChunks({
        toolCallId: "call-interrupted",
        name: "read_logs",
        input: {},
        result: '{"status":"interrupted"}',
      }),
    ],
    terminal: "abort",
  });

  const record = store.threads.get("thread")?.[0];
  assert.equal(record?.status, "aborted");
  assert.deepEqual(
    record?.tools.map((tool) => tool.outcome),
    ["error", "interrupted"],
  );
});

test("scrubs secret keys, applies caller redaction, and caps content", async () => {
  const store = inMemoryStore();
  await simulateRun({
    store,
    middlewareOptions: {
      maxResultChars: 20,
      redact: (entry) => ({
        ...entry,
        resultPreview: entry.resultPreview.replaceAll("C123", "[channel]"),
      }),
    },
    chunks: toolCallChunks({
      toolCallId: "call-1",
      name: "http_request",
      input: {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer sk-live-abc", api_key: "k" },
      },
      result: `channel C123 ${"x".repeat(100)}`,
    }),
  });

  const tool = store.threads.get("thread")?.[0]?.tools[0];
  assert.ok(tool);
  assert.ok(tool.args.includes('"Authorization":"[redacted]"'));
  assert.ok(tool.args.includes('"api_key":"[redacted]"'));
  assert.ok(!tool.args.includes("sk-live-abc"));
  assert.ok(tool.resultPreview.startsWith("channel [channel]"));
  assert.ok(tool.resultPreview.length <= 32);
  assert.equal(store.threads.get("thread")?.[0]?.truncated, true);
});

test("injects a digest only when the turn does not resume a native session", async () => {
  const store = inMemoryStore();
  await simulateRun({
    store,
    runId: "earlier-run",
    chunks: toolCallChunks({
      toolCallId: "call-1",
      name: "read_logs",
      input: { service: "api" },
      result: "42 errors",
    }),
  });

  const fresh = await simulateRun({ store, runId: "fresh-run" });
  const patch = fresh.configPatch;
  assert.ok(patch && patch.systemPrompts);
  assert.equal(patch.systemPrompts.length, 2);
  const digest = String(patch.systemPrompts[1]);
  assert.ok(digest.includes("Prior agent activity"));
  assert.ok(digest.includes("earlier-run"));
  assert.ok(digest.includes('read_logs {"service":"api"} → ok: 42 errors'));

  const resumed = await simulateRun({
    store,
    runId: "resumed-run",
    modelOptions: { sessionId: "native-session" },
  });
  assert.equal(resumed.configPatch, undefined);
});

test("upserts by run id and prunes to the record cap", async () => {
  const store = inMemoryStore();
  const chunks = toolCallChunks({
    toolCallId: "call-1",
    name: "read_logs",
    input: {},
    result: "ok",
  });
  await simulateRun({ store, runId: "run-1", chunks });
  await simulateRun({ store, runId: "run-1", chunks });
  assert.equal(store.threads.get("thread")?.length, 1);

  await simulateRun({
    store,
    runId: "run-2",
    chunks,
    middlewareOptions: { maxRecords: 2 },
  });
  await simulateRun({
    store,
    runId: "run-3",
    chunks,
    middlewareOptions: { maxRecords: 2 },
  });
  assert.deepEqual(
    store.threads.get("thread")?.map((record) => record.runId),
    ["run-2", "run-3"],
  );
});

test("persists a record when the run fails", async () => {
  const store = inMemoryStore();
  await simulateRun({
    store,
    chunks: toolCallChunks({
      toolCallId: "call-1",
      name: "read_logs",
      input: {},
      result: "partial",
    }),
    terminal: "error",
  });
  assert.equal(store.threads.get("thread")?.[0]?.status, "failed");
});

test("a failing store never fails the run's terminal hooks", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const store = defineRunMemoryStore({
    async load() {
      throw new Error("load unavailable");
    },
    async save() {
      throw new Error("save unavailable");
    },
  });
  await assert.doesNotReject(
    simulateRun({
      store,
      chunks: toolCallChunks({
        toolCallId: "call-1",
        name: "read_logs",
        input: {},
        result: "ok",
      }),
    }),
  );
  assert.ok(warn.mock.calls.length >= 1);
});

test("digest budget drops whole oldest runs first", () => {
  const record = (runId: string): RunMemoryRecord => ({
    version: 1,
    runId,
    provider: "claude-code",
    startedAt: 0,
    status: "completed",
    tools: [
      {
        toolCallId: `${runId}-call`,
        name: "read_logs",
        args: "{}",
        outcome: "ok",
        resultPreview: "y".repeat(120),
      },
    ],
    truncated: false,
  });
  const full = buildRunMemoryDigest([record("run-1"), record("run-2")], 10_000);
  assert.ok(full?.includes("run-1") && full.includes("run-2"));

  const trimmed = buildRunMemoryDigest(
    [record("run-1"), record("run-2")],
    400,
  );
  assert.ok(trimmed);
  assert.ok(!trimmed.includes("run-1"));
  assert.ok(trimmed.includes("run-2"));
  assert.equal(buildRunMemoryDigest([], 400), undefined);
});

test("metadataRunMemoryStore round-trips through the TanStack metadata store", async () => {
  const persistence = memoryPersistence();
  const store = metadataRunMemoryStore(persistence.stores.metadata);
  assert.deepEqual(await store.load("thread"), []);

  const record: RunMemoryRecord = {
    version: 1,
    runId: "run-1",
    provider: "codex",
    startedAt: 5,
    status: "completed",
    tools: [],
    truncated: false,
  };
  await store.save("thread", [record]);
  assert.deepEqual(await store.load("thread"), [record]);

  await persistence.stores.metadata.set("run-memory", "corrupt", {
    not: "records",
  });
  assert.deepEqual(await store.load("corrupt"), []);
});
