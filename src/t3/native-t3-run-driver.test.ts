import assert from "node:assert/strict";
import test from "node:test";
import { requestRunCancel } from "@tanstack/ai";
import { createAgentRunDurability } from "../durability/runtime.js";
import { EventType, type StreamChunk } from "./agui-protocol.js";
import type { T3ThreadSnapshot, T3TurnDispatch } from "./client.js";
import type { T3GatewayTurn } from "./gateway.js";
import {
  driveNativeT3Run,
  finalizeNativeT3Run,
  type NativeT3DriverGateway,
} from "./native-t3-run-driver.js";
import {
  NativeT3RunRequestStore,
  type NativeT3RunRequest,
} from "./run-request-store.js";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type { MetadataStore } from "./storage.js";

const binding: T3ThreadBinding = {
  canonicalThreadId: "thread-1",
  providerInstanceId: "claudeAgent",
  t3ThreadId: "native-thread-1",
  projectId: "project-1",
  sandboxId: "sandbox-1",
  baseUrl: "https://sandbox.example",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  status: "working",
  createdAt: "2026-08-31T15:00:00.000Z",
  updatedAt: "2026-08-31T15:00:01.000Z",
};

const dispatch: T3TurnDispatch = {
  sequence: 3,
  commandId: "command-1",
  messageId: "message-1",
  threadId: "native-thread-1",
  createdAt: "2026-08-31T15:00:01.000Z",
};

const userMessage = {
  id: "message-1",
  role: "user" as const,
  text: "run pwd",
  turnId: "turn-1",
  streaming: false,
  createdAt: "2026-08-31T15:00:01.000Z",
  updatedAt: "2026-08-31T15:00:01.000Z",
};

function snapshotAt(input: {
  assistantText: string;
  streaming: boolean;
  terminal: boolean;
  failed?: boolean;
}): T3ThreadSnapshot {
  return {
    snapshotSequence: input.terminal ? 9 : 5,
    thread: {
      id: "native-thread-1",
      projectId: "project-1",
      title: "Investigate the thing",
      modelSelection: binding.modelSelection,
      latestTurn: {
        turnId: "turn-1",
        state: input.terminal ? (input.failed ? "error" : "completed") : "running",
        requestedAt: "2026-08-31T15:00:01.000Z",
        startedAt: "2026-08-31T15:00:01.000Z",
        completedAt: input.terminal ? "2026-08-31T15:00:05.000Z" : null,
        assistantMessageId: "assistant-1",
      },
      messages: [
        userMessage,
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: input.assistantText,
          turnId: "turn-1",
          streaming: input.streaming,
          createdAt: "2026-08-31T15:00:02.000Z",
          updatedAt: "2026-08-31T15:00:03.000Z",
        },
      ],
      session: {
        status: "ready",
        activeTurnId: null,
        lastError: input.failed ? "The provider crashed." : null,
      },
    },
  } as unknown as T3ThreadSnapshot;
}

function memoryMetadata(): MetadataStore {
  const data = new Map<string, unknown>();
  return {
    async get(namespace, key) {
      const value = data.get(`${namespace}:${key}`);
      return value === undefined ? null : value;
    },
    async set(namespace, key, value) {
      data.set(`${namespace}:${key}`, JSON.parse(JSON.stringify(value)));
    },
    async delete(namespace, key) {
      data.delete(`${namespace}:${key}`);
    },
  };
}

type WaitBehavior = (input: {
  onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  signal?: AbortSignal;
}) => Promise<T3ThreadSnapshot>;

function fakeGateway(waitBehaviors: WaitBehavior[]) {
  const calls = {
    sends: 0,
    resumes: 0,
    waits: 0,
    cancels: 0,
    releases: 0,
  };
  const gateway: NativeT3DriverGateway = {
    async send() {
      calls.sends += 1;
      return { binding, dispatch } satisfies T3GatewayTurn;
    },
    async resumeTurn(canonicalThreadId, resumedDispatch) {
      calls.resumes += 1;
      assert.equal(canonicalThreadId, "thread-1");
      return { binding, dispatch: resumedDispatch };
    },
    async waitForTerminal(input) {
      const behavior = waitBehaviors[calls.waits];
      calls.waits += 1;
      if (!behavior) throw new Error("no scripted waitForTerminal behavior");
      return behavior(input);
    },
    async cancel() {
      calls.cancels += 1;
      return 1;
    },
    async releaseWorkerAfterRun() {
      calls.releases += 1;
    },
  };
  return { gateway, calls };
}

async function harness(runId: string, waitBehaviors: WaitBehavior[]) {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const requests = new NativeT3RunRequestStore(memoryMetadata());
  const { gateway, calls } = fakeGateway(waitBehaviors);
  const request: NativeT3RunRequest = {
    runId,
    canonicalThreadId: "thread-1",
    provider: "claude-code",
    title: "Investigate the thing",
    text: "run pwd",
    modelSelection: binding.modelSelection,
    inputFiles: [],
    collectArtifacts: false,
    createdAt: "2026-08-31T15:00:00.000Z",
  };
  await durability.runs.createOrResume({
    runId,
    threadId: "thread-1",
    startedAt: Date.now(),
  });
  await requests.saveRequest(request);
  const chunks = async () =>
    (await durability.stream(runId).snapshot()).map(
      (entry) => entry.chunk as unknown as StreamChunk,
    );
  return { durability, requests, gateway, calls, chunks, runId };
}

test("drives a native T3 run to completion against durable state", async (t) => {
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-complete", [
    async ({ onSnapshot }) => {
      await onSnapshot?.(snapshotAt({ assistantText: "Wor", streaming: true, terminal: false }));
      const terminal = snapshotAt({ assistantText: "Working directory is /workspace", streaming: false, terminal: true });
      await onSnapshot?.(terminal);
      return terminal;
    },
  ]);
  t.after(() => durability.close());

  const outcome = await driveNativeT3Run(
    { gateway, durability, requests },
    runId,
  );

  assert.equal(outcome.status, "completed");
  assert.equal(calls.sends, 1);
  assert.equal(calls.releases, 1);
  const events = await chunks();
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  const text = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta)
    .join("");
  assert.equal(text, "Working directory is /workspace");
  const run = await durability.runs.get(runId);
  assert.equal(run?.status, "completed");
});

test("a retried driver resumes projection without duplicating events", async (t) => {
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-resume", [
    async ({ onSnapshot }) => {
      await onSnapshot?.(snapshotAt({ assistantText: "Working dir", streaming: true, terminal: false }));
      throw new Error("controller crashed mid-watch");
    },
    async ({ onSnapshot }) => {
      const terminal = snapshotAt({ assistantText: "Working directory is /workspace", streaming: false, terminal: true });
      await onSnapshot?.(terminal);
      return terminal;
    },
  ]);
  t.after(() => durability.close());
  const deps = { gateway, durability, requests };

  // Attempt 1: transient failure must NOT terminalize the run.
  await assert.rejects(
    () => driveNativeT3Run(deps, runId),
    /controller crashed mid-watch/,
  );
  assert.equal((await durability.runs.get(runId))?.status, "running");
  assert.equal(calls.sends, 1);

  // Attempt 2: resume. No second dispatch, no duplicated chunks.
  const outcome = await driveNativeT3Run(deps, runId);
  assert.equal(outcome.status, "completed");
  assert.equal(calls.sends, 1, "the worker turn is dispatched exactly once");
  assert.equal(calls.resumes, 1);

  const events = await chunks();
  assert.equal(
    events.filter((event) => event.type === EventType.RUN_STARTED).length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === EventType.TEXT_MESSAGE_START).length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === EventType.RUN_FINISHED).length,
    1,
  );
  const text = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta)
    .join("");
  assert.equal(text, "Working directory is /workspace");
  assert.equal((await durability.runs.get(runId))?.status, "completed");
});

test("a run cancelled before dispatch converges without contacting the worker", async (t) => {
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-precancel", []);
  t.after(() => durability.close());
  await requestRunCancel(durability.runs, runId);

  const outcome = await driveNativeT3Run(
    { gateway, durability, requests },
    runId,
  );

  assert.equal(outcome.status, "aborted");
  assert.equal(calls.sends, 0);
  const events = await chunks();
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal((await durability.runs.get(runId))?.status, "aborted");
});

test("an aborted signal interrupts the worker and terminalizes as aborted", async (t) => {
  const abort = new AbortController();
  let armCancel: () => Promise<void>;
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-abort", [
    async ({ onSnapshot, signal }) => {
      await onSnapshot?.(snapshotAt({ assistantText: "Working", streaming: true, terminal: false }));
      // The real cancel flow records durable intent before the workflow (and
      // therefore the activity) is cancelled.
      await armCancel();
      abort.abort();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("watch aborted"));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      });
    },
  ]);
  armCancel = () => requestRunCancel(durability.runs, runId).then(() => undefined);
  t.after(() => durability.close());

  const outcome = await driveNativeT3Run(
    { gateway, durability, requests },
    runId,
    { signal: abort.signal },
  );

  assert.equal(outcome.status, "aborted");
  assert.equal(calls.cancels, 1, "the worker turn is interrupted");
  const events = await chunks();
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.match(String(events.at(-1)?.message), /cancelled/);
  assert.equal((await durability.runs.get(runId))?.status, "aborted");
});

test("finalize converges an abandoned run and is idempotent for terminal ones", async (t) => {
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-finalize", []);
  t.after(() => durability.close());

  await finalizeNativeT3Run({ durability, requests, gateway }, runId, {
    cancelled: false,
    message: "workflow retries exhausted",
  });

  const run = await durability.runs.get(runId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.error?.message, "workflow retries exhausted");
  const events = await chunks();
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(calls.releases, 1);

  // Second finalize must not overwrite the terminal record.
  await finalizeNativeT3Run({ durability, requests, gateway }, runId, {
    cancelled: true,
    message: "late duplicate finalize",
  });
  assert.equal((await durability.runs.get(runId))?.status, "failed");
});

test("a superseded driver claim cannot append or terminalize", async (t) => {
  const { durability, requests, gateway, chunks, runId } = await harness("run-fenced", [
    async ({ onSnapshot }) => {
      await onSnapshot?.(snapshotAt({ assistantText: "Working", streaming: true, terminal: false }));
      // A newer driver (retry attempt or takeover) claims the run.
      await durability.runs.update(runId, { driverEpoch: 999 });
      const terminal = snapshotAt({ assistantText: "Working fine", streaming: false, terminal: true });
      await onSnapshot?.(terminal);
      return terminal;
    },
  ]);
  t.after(() => durability.close());

  await assert.rejects(
    () => driveNativeT3Run({ gateway, durability, requests }, runId),
    /superseded/,
  );
  // The superseded driver neither appended the terminal chunk nor closed out
  // the record; the claim owner converges the run.
  const events = await chunks();
  assert.ok(!events.some((event) => event.type === EventType.RUN_FINISHED));
  assert.equal((await durability.runs.get(runId))?.status, "running");
});


test("an attempt cancellation without run intent hands off instead of interrupting", async (t) => {
  const abort = new AbortController();
  const { durability, requests, gateway, calls, chunks, runId } = await harness("run-handoff", [
    async ({ onSnapshot, signal }) => {
      await onSnapshot?.(snapshotAt({ assistantText: "Still working", streaming: true, terminal: false }));
      // Simulate a startToClose timeout / worker drain: Temporal cancels the
      // attempt but nobody requested run cancellation.
      abort.abort();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("watch aborted"));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      });
    },
    async ({ onSnapshot }) => {
      const terminal = snapshotAt({ assistantText: "Still working, now done", streaming: false, terminal: true });
      await onSnapshot?.(terminal);
      return terminal;
    },
  ]);
  t.after(() => durability.close());
  const deps = { gateway, durability, requests };

  // The cancelled attempt must throw for retry and must NOT touch the turn.
  await assert.rejects(() => driveNativeT3Run(deps, runId, { signal: abort.signal }));
  assert.equal(calls.cancels, 0, "the worker turn is never interrupted");
  assert.equal((await durability.runs.get(runId))?.status, "running");
  const midway = await chunks();
  assert.ok(!midway.some((event) => event.type === EventType.RUN_ERROR));

  // The next attempt reattaches and completes the run normally.
  const outcome = await driveNativeT3Run(deps, runId);
  assert.equal(outcome.status, "completed");
  assert.equal(calls.sends, 1, "still dispatched exactly once");
  const events = await chunks();
  assert.equal(events.filter((event) => event.type === EventType.RUN_FINISHED).length, 1);
  const text = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta)
    .join("");
  assert.equal(text, "Still working, now done");
});

test("a pre-watch attempt cancellation without run intent retries instead of aborting", async (t) => {
  const abort = new AbortController();
  abort.abort();
  const { durability, requests, gateway, calls, runId } = await harness("run-prehandoff", []);
  t.after(() => durability.close());

  await assert.rejects(
    () => driveNativeT3Run({ gateway, durability, requests }, runId, { signal: abort.signal }),
    /cancelled before watching/,
  );
  assert.equal(calls.sends, 0);
  assert.equal((await durability.runs.get(runId))?.status, "running");
});
