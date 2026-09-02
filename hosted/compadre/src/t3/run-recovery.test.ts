import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "./agui-protocol.js";
import type { T3Gateway } from "./gateway.js";
import type { NativeT3RunCoordinator } from "./run-coordinator.js";
import { recoverNativeT3Runs } from "./run-recovery.js";

test("startup recovery reattaches the exact provider run without dispatching again", async () => {
  const startedAt = Date.parse("2026-08-31T14:00:00.000Z");
  const binding = {
    canonicalThreadId: "thread-1",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-1",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://worker.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "working" as const,
    activeRunId: "run-1",
    createdAt: "2026-08-31T13:59:00.000Z",
    updatedAt: "2026-08-31T14:00:01.000Z",
  };
  const snapshot = {
    snapshotSequence: 8,
    thread: {
      id: binding.t3ThreadId,
      projectId: binding.projectId,
      title: "Recovered",
      modelSelection: binding.modelSelection,
      latestTurn: {
        turnId: "turn-1",
        state: "completed" as const,
        requestedAt: "2026-08-31T14:00:01.000Z",
        startedAt: "2026-08-31T14:00:01.000Z",
        completedAt: "2026-08-31T14:00:04.000Z",
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: "message-1",
          role: "user" as const,
          text: "do the work",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-31T14:00:01.000Z",
          updatedAt: "2026-08-31T14:00:01.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "done",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-31T14:00:04.000Z",
          updatedAt: "2026-08-31T14:00:04.000Z",
        },
      ],
      session: { status: "ready" as const, activeTurnId: null, lastError: null },
    },
  };
  let cleared = false;
  let sends = 0;
  const gateway = {
    async list() { return [binding]; },
    async snapshot() { return { binding, snapshot, source: "worker" as const }; },
    async waitForTerminal() { throw new Error("terminal snapshot should not wait"); },
    async markActiveRun() {},
    async clearActiveRun() { cleared = true; },
    async cancel() { return null; },
    async send() { sends += 1; throw new Error("recovery must not dispatch"); },
  } as unknown as T3Gateway;
  const recoveredEvents: string[] = [];
  const run = {
    runId: "run-1",
    threadId: "thread-1",
    status: "running" as const,
    startedAt,
  };
  const coordinator = {
    async run(runId: string) { return runId === run.runId ? run : null; },
    async resume(input: Parameters<NativeT3RunCoordinator["resume"]>[0]) {
      for await (const event of input.source(new AbortController().signal)) {
        recoveredEvents.push(event.type);
      }
      return { run, resumed: true };
    },
  } as unknown as NativeT3RunCoordinator;

  const summary = await recoverNativeT3Runs({ gateway, coordinator });

  assert.deepEqual(summary, { scanned: 1, resumed: 1, skipped: 0 });
  assert.equal(sends, 0);
  assert.equal(cleared, true);
  assert.ok(recoveredEvents.includes(EventType.RUN_FINISHED));
});

test("startup recovery preserves a completed run as a ready thread", async () => {
  let clearedStatus: string | undefined;
  const binding = {
    canonicalThreadId: "thread-completed",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-completed",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://worker.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "working" as const,
    activeRunId: "run-completed",
    createdAt: "2026-08-31T13:59:00.000Z",
    updatedAt: "2026-08-31T14:00:01.000Z",
  };
  const gateway = {
    async list() { return [binding]; },
    async clearActiveRun(_threadId: string, _runId: string, status?: string) {
      clearedStatus = status;
    },
  } as unknown as T3Gateway;
  const run = {
    runId: "run-completed",
    threadId: "thread-completed",
    status: "completed" as const,
    startedAt: Date.parse("2026-08-31T14:00:00.000Z"),
    finishedAt: Date.parse("2026-08-31T14:00:04.000Z"),
  };
  const coordinator = {
    async run() { return run; },
    async resume() { throw new Error("terminal runs must not resume"); },
  } as unknown as NativeT3RunCoordinator;

  const summary = await recoverNativeT3Runs({ gateway, coordinator });

  assert.deepEqual(summary, { scanned: 1, resumed: 0, skipped: 1 });
  assert.equal(clearedStatus, "ready");
});
