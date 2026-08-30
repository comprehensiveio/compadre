import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import type { LockStore } from "./storage.js";
import {
  buildT3HostedThreadUrl,
  T3Gateway,
  type T3CommandClient,
  type T3EnvironmentConnectionManager,
} from "./gateway.js";

class CapacityLockStore implements LockStore {
  private held = 0;
  private readonly waiters: Array<{
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly capacity: number,
    private readonly acquireTimeoutMs: number,
  ) {}

  private async acquire(): Promise<void> {
    if (this.held < this.capacity) {
      this.held += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.held += 1;
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("test lock capacity exhausted"));
        }, this.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.held -= 1;
    this.waiters.shift()?.resolve();
  }

  async withLock<T>(
    _key: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.acquire();
    try {
      return await operation(new AbortController().signal);
    } finally {
      this.release();
    }
  }
}

test("builds one-time hosted T3 links that retain the native thread target", () => {
  const url = new URL(
    buildT3HostedThreadUrl({
      hostedAppUrl: "https://t3-ui.example/",
      environmentUrl: "https://modal-thread.example/",
      pairingCredential: "secret-once",
      threadId: "t3-thread-1",
      label: "Slack request",
    }),
  );

  assert.equal(url.origin, "https://t3-ui.example");
  assert.equal(url.pathname, "/pair");
  assert.equal(url.searchParams.get("host"), "https://modal-thread.example/");
  assert.equal(url.searchParams.get("threadId"), "t3-thread-1");
  assert.equal(url.searchParams.get("label"), "Slack request");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.hash, "#token=secret-once");
});

test("routes model changes through the same provider-native T3 thread", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const starts: string[] = [];
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      starts.push(`new:${input.threadId}:${input.text}`);
      return {
        sequence: 10,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn(input) {
      starts.push(`existing:${input.threadId}:${input.text}`);
      return {
        sequence: 20,
        commandId: "command-2",
        messageId: "message-2",
        threadId: input.threadId,
        createdAt: "2026-08-26T15:00:01.000Z",
      };
    },
    async interruptTurn() {
      return 30;
    },
    async waitForTurnTerminal() {
      throw new Error("unused");
    },
    async threadSnapshot() {
      throw new Error("unused");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  };
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return { sandboxId: "sandbox-1", projectId: "project-1", client };
    },
    async reconnect() {
      return { sandboxId: "sandbox-1", projectId: "project-1", client };
    },
  };
  const gateway = new T3Gateway(
    bindings,
    environments,
    () => "t3-thread-1",
    () => new Date("2026-08-26T15:00:00.000Z"),
  );

  const selection = { instanceId: "codex", model: "gpt-5.6-sol" };
  const first = await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Slack request",
    text: "first",
    modelSelection: selection,
  });
  const second = await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Slack request",
    text: "second",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol-fast" },
  });

  assert.equal(first.binding.t3ThreadId, "t3-thread-1");
  assert.equal(second.binding.t3ThreadId, "t3-thread-1");
  assert.equal(second.binding.providerInstanceId, "codex");
  assert.deepEqual(starts, [
    "new:t3-thread-1:first",
    "existing:t3-thread-1:second",
  ]);
});

test("does not nest directory-index locks inside first-turn environment locks", async () => {
  const persistence = memoryPersistence();
  const locks = new CapacityLockStore(4, 100);
  const bindings = new T3ThreadBindingStore(
    persistence.stores.metadata,
    locks,
  );
  let nextId = 0;
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      return {
        sequence: 1,
        commandId: `command-${input.threadId}`,
        messageId: `message-${input.threadId}`,
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn() { throw new Error("unused"); },
    async interruptTurn() { throw new Error("unused"); },
    async waitForTurnTerminal() { throw new Error("unused"); },
    async threadSnapshot() { throw new Error("unused"); },
    async mintPairingCredential() { throw new Error("unused"); },
  };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox", projectId: "project", client };
      },
      async reconnect() { throw new Error("unused"); },
    },
    () => `t3-thread-${nextId++}`,
    () => new Date("2026-08-26T15:00:00.000Z"),
    locks,
  );

  const turns = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    gateway.send({
      canonicalThreadId: `canonical-${index}`,
      title: `Concurrent ${index}`,
      text: `Message ${index}`,
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    })));

  assert.equal(turns.length, 4);
  assert.ok(turns.every((turn) => turn.binding.status === "working"));
});

test("forwards image inputs on both new and resumed native T3 threads", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const received: Array<{ kind: "new" | "resumed"; names: string[] }> = [];
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      received.push({
        kind: "new",
        names: (input.inputFiles ?? []).map((file) => file.name),
      });
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn(input) {
      received.push({
        kind: "resumed",
        names: (input.inputFiles ?? []).map((file) => file.name),
      });
      return {
        sequence: 2,
        commandId: "command-2",
        messageId: "message-2",
        threadId: input.threadId,
        createdAt: "2026-08-26T15:00:01.000Z",
      };
    },
    async interruptTurn() { return 3; },
    async waitForTurnTerminal() { throw new Error("unused"); },
    async threadSnapshot() { throw new Error("unused"); },
    async mintPairingCredential() { throw new Error("unused"); },
  };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
      async reconnect() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
    },
    () => "t3-thread-1",
  );
  const inputFile = {
    name: "diagram.png",
    mimetype: "image/png" as const,
    sizeBytes: 4,
    dataBase64: "iVBORw==",
  };
  const request = {
    canonicalThreadId: "slack-thread-with-image",
    title: "Slack image",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  };

  await gateway.send({ ...request, text: "first", inputFiles: [inputFile] });
  await gateway.send({ ...request, text: "second", inputFiles: [inputFile] });

  assert.deepEqual(received, [
    { kind: "new", names: ["diagram.png"] },
    { kind: "resumed", names: ["diagram.png"] },
  ]);
});

test("requires a new native T3 thread when switching provider harnesses", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn() { throw new Error("unused"); },
    async interruptTurn() { throw new Error("unused"); },
    async waitForTurnTerminal() { throw new Error("unused"); },
    async threadSnapshot() { throw new Error("unused"); },
    async mintPairingCredential() { throw new Error("unused"); },
  } satisfies T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
      async reconnect() {
        throw new Error("provider switch should fail before reconnect");
      },
    },
    () => "thread-1",
  );
  await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Question",
    text: "first",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await assert.rejects(
    gateway.send({
      canonicalThreadId: "slack-thread",
      title: "Question",
      text: "second",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    }),
    /start a new thread/,
  );
});

test("cancel is a no-op until an external thread has a T3 binding", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      throw new Error("unused");
    },
  };
  const gateway = new T3Gateway(bindings, environments);
  assert.equal(
    await gateway.cancel({
      canonicalThreadId: "missing",
      providerInstanceId: "codex",
    }),
    null,
  );
});

test("discards a newly provisioned Modal environment when its first turn fails", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const discarded: string[] = [];
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread() {
      throw new Error("dispatch failed");
    },
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      throw new Error("unused");
    },
    async waitForTurnTerminal() {
      throw new Error("unused");
    },
    async threadSnapshot() {
      throw new Error("unused");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  } satisfies T3CommandClient;
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return { sandboxId: "sandbox-failed", projectId: "project-1", client };
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const gateway = new T3Gateway(bindings, environments);
  await assert.rejects(
    gateway.send({
      canonicalThreadId: "slack-thread",
      title: "Failure",
      text: "fail",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    }),
    /dispatch failed/,
  );
  assert.deepEqual(discarded, ["sandbox-failed"]);
});

test("runs internal text generation in a disposable unbound T3 environment", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const provisioned: string[] = [];
  const discarded: string[] = [];
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread(input: { threadId?: string; title: string; text: string }) {
      assert.equal(input.title, "Internal text generation");
      assert.equal(input.text, "Return JSON with a concise title");
      return {
        sequence: 10,
        commandId: "command-generate",
        messageId: "message-generate",
        threadId: input.threadId!,
        createdAt: "2026-08-27T15:00:00.000Z",
      };
    },
    async startTurn() { throw new Error("unused"); },
    async interruptTurn() { throw new Error("unused"); },
    async waitForTurnTerminal() {
      return {
        snapshotSequence: 12,
        thread: {
          id: "native-generation-thread",
          projectId: "project-1",
          title: "Internal text generation",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
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
              id: "assistant-generate",
              role: "assistant" as const,
              text: '{"title":"Concise title"}',
              turnId: "turn-generate",
              streaming: false,
              createdAt: "2026-08-27T15:00:01.000Z",
              updatedAt: "2026-08-27T15:00:01.000Z",
            },
          ],
          session: { status: "ready" as const, activeTurnId: null, lastError: null },
        },
      };
    },
    async threadSnapshot() { throw new Error("unused"); },
    async mintPairingCredential() { throw new Error("unused"); },
  } satisfies T3CommandClient;
  const environments: T3EnvironmentConnectionManager = {
    async provision(input) {
      provisioned.push(input.canonicalThreadId);
      return { sandboxId: "sandbox-generation", projectId: "project-1", client };
    },
    async reconnect() { throw new Error("unused"); },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const ids = ["generation-1", "native-generation-thread"];
  const gateway = new T3Gateway(bindings, environments, () => ids.shift()!);

  const generated = await gateway.generateText({
    prompt: "Return JSON with a concise title",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    timeoutMs: 30_000,
  });

  assert.equal(generated.snapshot.thread.messages[0]?.text, '{"title":"Concise title"}');
  assert.deepEqual(provisioned, ["internal-text-generation:generation-1"]);
  assert.deepEqual(discarded, ["sandbox-generation"]);
  assert.deepEqual(await bindings.list(), []);
});

test("serves a completed thread from central storage without reconnecting Modal", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const snapshots = new T3ThreadSnapshotStore(persistence.stores.metadata);
  let reconnects = 0;
  const terminalSnapshot = {
    snapshotSequence: 15,
    thread: {
      id: "t3-thread-1",
      projectId: "project-1",
      title: "Central thread",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      latestTurn: {
        turnId: "turn-1",
        state: "completed" as const,
        requestedAt: "2026-08-26T15:00:00.000Z",
        startedAt: "2026-08-26T15:00:00.000Z",
        completedAt: "2026-08-26T15:00:05.000Z",
        assistantMessageId: "assistant-1",
      },
      messages: [],
      session: { status: "ready" as const, activeTurnId: null, lastError: null },
      activities: [{ id: "activity-1", type: "command.completed", title: "pwd" }],
    },
  };
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 10,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: "2026-08-26T15:00:00.000Z",
      };
    },
    async startTurn() { throw new Error("unused"); },
    async interruptTurn() { throw new Error("unused"); },
    async waitForTurnTerminal(input: {
      onSnapshot?(snapshot: typeof terminalSnapshot): void | Promise<void>;
    }) {
      await input.onSnapshot?.(terminalSnapshot);
      return terminalSnapshot;
    },
    async threadSnapshot() { throw new Error("Modal should not be read after completion"); },
    async mintPairingCredential() { throw new Error("unused"); },
  } satisfies T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
      async reconnect() {
        reconnects += 1;
        if (reconnects > 1) throw new Error("Modal is unavailable");
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
    },
    () => "t3-thread-1",
    () => new Date("2026-08-26T15:00:06.000Z"),
    undefined,
    "https://t3-ui.example",
    snapshots,
  );

  const turn = await gateway.send({
    canonicalThreadId: "slack-thread",
    title: "Central thread",
    text: "run pwd",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  });
  await gateway.waitForTerminal({ turn });
  const result = await gateway.snapshot({
    canonicalThreadId: "slack-thread",
    providerInstanceId: "claudeAgent",
  });

  assert.equal(reconnects, 1);
  assert.equal(result?.source, "central");
  assert.equal(result?.snapshot.snapshotSequence, 15);
  assert.deepEqual(result?.snapshot.thread.activities, [
    { id: "activity-1", type: "command.completed", title: "pwd" },
  ]);
});
