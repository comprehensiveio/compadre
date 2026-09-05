import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import { InMemoryLockStore, type LockStore } from "./storage.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { CodexSubscriptionLane } from "./codex-subscription-lane.js";
import {
  buildT3HostedThreadUrl,
  T3EnvironmentUnavailableError,
  T3Gateway,
  type T3CommandClient,
  type T3EnvironmentConnection,
  type T3EnvironmentConnectionManager,
} from "./gateway.js";

const completedSnapshot = {
  snapshotSequence: 2,
  thread: {
    id: "t3-thread-1",
    projectId: "project-1",
    title: "Restorable thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    latestTurn: {
      turnId: "turn-1",
      state: "completed" as const,
      requestedAt: "2026-08-30T12:00:00.000Z",
      startedAt: "2026-08-30T12:00:00.000Z",
      completedAt: "2026-08-30T12:00:05.000Z",
      assistantMessageId: "assistant-1",
    },
    messages: [],
    session: { status: "ready" as const, activeTurnId: null, lastError: null },
  },
};

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

test("hands one subscription lane between workers while concurrent work stays on API", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const locks = new InMemoryLockStore();
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refresh-token" },
  });
  const lane = new CodexSubscriptionLane(persistence.stores.metadata, locks, {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "true",
    COMPADRE_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    CODEX_AUTH_JSON_BASE64: Buffer.from(authJson).toString("base64"),
  });
  const workers = new Map<
    string,
    {
      files: Map<string, string>;
      commands: string[];
      stopped: boolean;
      connection: T3EnvironmentConnection;
    }
  >();
  const environments: T3EnvironmentConnectionManager = {
    async provision(input) {
      const files = new Map([
        ["/home/node/.codex/compadre-auth-route", "api"],
        ["/home/node/.codex/auth.json", '{"auth_mode":"apikey"}'],
      ]);
      const commands: string[] = [];
      const worker = {
        files,
        commands,
        stopped: false,
        connection: undefined as unknown as T3EnvironmentConnection,
      };
      const client: T3CommandClient = {
        baseUrl: `https://${input.canonicalThreadId}.example`,
        async startNewThread(turn) {
          worker.stopped = false;
          return {
            sequence: 1,
            commandId: `command-${input.canonicalThreadId}`,
            messageId: `message-${input.canonicalThreadId}`,
            threadId: turn.threadId!,
            createdAt: "2026-09-03T12:00:00.000Z",
          };
        },
        async startTurn() {
          throw new Error("unused");
        },
        async interruptTurn() {
          return 1;
        },
        async stopSession() {
          worker.stopped = true;
          return 2;
        },
        async threadSnapshot() {
          return {
            ...completedSnapshot,
            thread: {
              ...completedSnapshot.thread,
              session: worker.stopped
                ? {
                    status: "stopped" as const,
                    activeTurnId: null,
                    lastError: null,
                  }
                : {
                    status: "ready" as const,
                    activeTurnId: null,
                    lastError: null,
                  },
            },
          };
        },
        async waitForTurnTerminal() {
          throw new Error("unused");
        },
        async mintPairingCredential() {
          throw new Error("unused");
        },
      };
      const sandbox = {
        process: {
          async exec(command: string | string[]) {
            commands.push(Array.isArray(command) ? command.join(" ") : command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        fs: {
          async read(path: string) {
            const value = files.get(path);
            if (value === undefined) throw new Error("not found");
            return value;
          },
          async write(path: string, contents: string) {
            files.set(path, contents);
          },
        },
      } as unknown as SandboxHandle;
      worker.connection = {
        sandboxId: `sandbox-${input.canonicalThreadId}`,
        projectId: `project-${input.canonicalThreadId}`,
        client,
        sandbox,
      };
      workers.set(input.canonicalThreadId, worker);
      return worker.connection;
    },
    async reconnect(binding) {
      return workers.get(binding.canonicalThreadId)!.connection;
    },
  };
  let id = 0;
  const gateway = new T3Gateway(
    bindings,
    environments,
    () => `thread-${++id}`,
    undefined,
    locks,
    undefined,
    undefined,
    undefined,
    lane,
    JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "api-secret",
    }),
  );

  await gateway.send({
    runId: "run-subscription",
    canonicalThreadId: "owner",
    title: "owner",
    text: "first",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await gateway.send({
    runId: "run-api",
    canonicalThreadId: "concurrent",
    title: "concurrent",
    text: "second",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.equal(
    workers.get("owner")!.files.get("/home/node/.codex/compadre-auth-route"),
    "subscription",
  );
  assert.equal(
    workers
      .get("concurrent")!
      .files.get("/home/node/.codex/compadre-auth-route"),
    "api",
  );

  await lane.claim({ canonicalThreadId: "owner", runId: "run-steer" });
  await gateway.releaseCodexAuth({
    canonicalThreadId: "owner",
    runId: "run-subscription",
  });
  assert.equal(
    workers.get("owner")!.stopped,
    false,
    "a stale finalizer must not stop a newer steer",
  );
  await gateway.releaseCodexAuth({
    canonicalThreadId: "owner",
    runId: "run-steer",
  });
  assert.equal(workers.get("owner")!.stopped, true);
  assert.equal(
    workers.get("owner")!.files.get("/home/node/.codex/compadre-auth-route"),
    "api",
  );
  assert.equal(
    workers.get("owner")!.files.get("/home/node/.codex/auth.json"),
    JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "api-secret",
    }),
  );
});

test("routes model changes through the same provider-native T3 thread", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const starts: string[] = [];
  const provisions: unknown[] = [];
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
    async provision(input) {
      provisions.push(input.blockedSlackDestination);
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
    blockedSlackDestination: { channelId: "C1", threadTs: "1.0" },
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
  assert.deepEqual(first.binding.blockedSlackDestination, {
    channelId: "C1",
    threadTs: "1.0",
  });
  assert.deepEqual(second.binding.blockedSlackDestination, {
    channelId: "C1",
    threadTs: "1.0",
  });
  assert.deepEqual(provisions, [{ channelId: "C1", threadTs: "1.0" }]);
  assert.deepEqual(starts, [
    "new:t3-thread-1:first",
    "existing:t3-thread-1:second",
  ]);
  await assert.rejects(
    gateway.send({
      canonicalThreadId: "slack-thread",
      title: "Slack request",
      text: "wrong destination",
      modelSelection: selection,
      blockedSlackDestination: { channelId: "C1", threadTs: "2.0" },
    }),
    /different Slack destination/,
  );
});

test("folds setup steering into provisioning and steers the active worker turn", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const starts: Array<{ messageId?: string; text: string }> = [];
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      starts.push({ text: input.text });
      return {
        sequence: 1,
        commandId: "command-initial",
        messageId: "message-initial",
        threadId: input.threadId!,
        createdAt: "2026-09-05T16:00:00.000Z",
      };
    },
    async startTurn(input) {
      starts.push({ messageId: input.messageId, text: input.text });
      return {
        sequence: 2,
        commandId: "command-steer",
        messageId: input.messageId ?? "message-steer",
        threadId: input.threadId,
        createdAt: "2026-09-05T16:00:01.000Z",
      };
    },
    async interruptTurn() { return 3; },
    async waitForTurnTerminal() { throw new Error("unused"); },
    async threadSnapshot(threadId) {
      return {
        ...completedSnapshot,
        thread: {
          ...completedSnapshot.thread,
          id: threadId,
          latestTurn: {
            ...completedSnapshot.thread.latestTurn,
            state: "running",
            completedAt: null,
          },
          session: { status: "running", activeTurnId: "turn-1", lastError: null },
        },
      };
    },
    async mintPairingCredential() { throw new Error("unused"); },
  };
  const connection = { sandboxId: "sandbox-1", projectId: "project-1", client };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() { return connection; },
      async reconnect() { return connection; },
    },
    () => "t3-thread-1",
    () => new Date("2026-09-05T16:00:00.000Z"),
  );

  await gateway.send({
    canonicalThreadId: "thread-steering",
    title: "Steering",
    text: "Original request",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    async loadInitialSteering() {
      return ["First follow-up", "Second follow-up"];
    },
  });
  assert.equal(
    await gateway.steer({
      canonicalThreadId: "thread-steering",
      id: "instruction-live",
      text: "Live follow-up",
    }),
    true,
  );

  assert.deepEqual(starts, [
    {
      text: [
        "Original request",
        "Follow-up instruction received during setup:\nFirst follow-up",
        "Follow-up instruction received during setup:\nSecond follow-up",
      ].join("\n\n"),
    },
    { messageId: "instruction-live", text: "Live follow-up" },
  ]);
});

test("durably records and conditionally clears the active provider run", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const createdAt = "2026-08-26T15:00:00.000Z";
  const initialBinding = {
    canonicalThreadId: "thread-active-run",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-active-run",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://t3.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "working" as const,
    createdAt,
    updatedAt: createdAt,
  };
  await bindings.bind(initialBinding);
  let receivedAbsoluteTimeoutMs: number | undefined;
  const client = {
    baseUrl: "https://t3.example",
    async waitForTurnTerminal(input: { absoluteTimeoutMs?: number }) {
      receivedAbsoluteTimeoutMs = input.absoluteTimeoutMs;
      return completedSnapshot;
    },
  } as unknown as T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        throw new Error("unused");
      },
      async reconnect() {
        return { sandboxId: "sandbox-1", projectId: "project-1", client };
      },
    },
    undefined,
    () => new Date("2026-08-26T15:01:00.000Z"),
  );

  await gateway.markActiveRun("thread-active-run", "run-1");
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, "run-1");
  await gateway.waitForTerminal({
    turn: {
      binding: initialBinding,
      dispatch: {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: initialBinding.t3ThreadId,
        createdAt,
      },
    },
    absoluteTimeoutMs: 99 * 60 * 60 * 1_000,
  });
  // 24h default lifetime - 1min elapsed - 5min watch safety margin.
  assert.equal(receivedAbsoluteTimeoutMs, (24 * 60 - 6) * 60 * 1_000);
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, "run-1");
  await gateway.clearActiveRun("thread-active-run", "older-run");
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, "run-1");
  await gateway.clearActiveRun("thread-active-run", "run-1");
  assert.equal(
    (await bindings.get("thread-active-run"))?.activeRunId,
    undefined,
  );
});

test("restores a suspended Modal worker before continuing the same T3 thread", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  await bindings.bind({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-1",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://old-worker.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    workerState: "suspended",
    workerGeneration: 1,
    workerSnapshotId: "im-checkpoint-1",
    sandboxStartedAt: "2026-08-30T10:00:00.000Z",
    lastActiveAt: "2026-08-30T10:05:00.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:05:00.000Z",
  });
  const starts: string[] = [];
  const restored: string[] = [];
  const client = {
    baseUrl: "https://restored-worker.example",
    async startNewThread() {
      throw new Error("unused");
    },
    async startTurn(input: { threadId: string }) {
      starts.push(input.threadId);
      return {
        sequence: 3,
        commandId: "command-2",
        messageId: "message-2",
        threadId: input.threadId,
        createdAt: "2026-08-30T13:00:00.000Z",
      };
    },
    async interruptTurn() {
      return 4;
    },
    async waitForTurnTerminal() {
      return completedSnapshot;
    },
    async threadSnapshot() {
      return completedSnapshot;
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  } satisfies T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        throw new Error("unused");
      },
      async reconnect() {
        throw new T3EnvironmentUnavailableError("sandbox-1");
      },
      async restore(binding) {
        restored.push(binding.workerSnapshotId!);
        return {
          sandboxId: "sandbox-2",
          projectId: binding.projectId,
          client,
        };
      },
    },
    () => "unused",
    () => new Date("2026-08-30T13:00:00.000Z"),
  );

  const turn = await gateway.send({
    canonicalThreadId: "canonical-thread",
    title: "Restorable thread",
    text: "continue",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.deepEqual(restored, ["im-checkpoint-1"]);
  assert.deepEqual(starts, ["t3-thread-1"]);
  assert.equal(turn.binding.sandboxId, "sandbox-2");
  assert.equal(turn.binding.baseUrl, "https://restored-worker.example");
  assert.equal(turn.binding.workerGeneration, 2);
  assert.equal(turn.binding.workerState, "running");
});

test("checkpoints a terminal turn, survives a restart, and restores after worker death", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  let currentTime = new Date("2026-08-30T12:00:00.000Z");
  let liveSandboxId: string | null = "sandbox-1";
  let checkpoints = 0;
  const starts: string[] = [];
  const client = (baseUrl: string): T3CommandClient => ({
    baseUrl,
    async startNewThread(input) {
      starts.push(`new:${input.threadId}`);
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: currentTime.toISOString(),
      };
    },
    async startTurn(input) {
      starts.push(`continue:${input.threadId}`);
      return {
        sequence: 3,
        commandId: "command-2",
        messageId: "message-2",
        threadId: input.threadId,
        createdAt: currentTime.toISOString(),
      };
    },
    async interruptTurn() {
      return 4;
    },
    async waitForTurnTerminal() {
      return completedSnapshot;
    },
    async threadSnapshot() {
      return completedSnapshot;
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  });
  let activeClient = client("https://worker-1.example");
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return {
        sandboxId: liveSandboxId!,
        projectId: "project-1",
        client: activeClient,
      };
    },
    async reconnect(binding) {
      if (binding.sandboxId !== liveSandboxId) {
        throw new T3EnvironmentUnavailableError(binding.sandboxId);
      }
      return {
        sandboxId: binding.sandboxId,
        projectId: binding.projectId,
        client: activeClient,
      };
    },
    async checkpoint() {
      // A live checkpoint never stops the worker.
      checkpoints += 1;
      return { snapshotId: "im-worker-checkpoint" };
    },
    async restore(binding) {
      assert.equal(binding.workerSnapshotId, "im-worker-checkpoint");
      liveSandboxId = "sandbox-2";
      activeClient = client("https://worker-2.example");
      return {
        sandboxId: liveSandboxId,
        projectId: binding.projectId,
        client: activeClient,
      };
    },
  };
  const firstController = new T3Gateway(
    bindings,
    environments,
    () => "t3-thread-1",
    () => currentTime,
  );
  const firstTurn = await firstController.send({
    canonicalThreadId: "canonical-thread",
    title: "Restartable thread",
    text: "first",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await firstController.waitForTerminal({ turn: firstTurn });

  // The terminal turn is checkpointed but the worker keeps running.
  const afterFirst = await bindings.get("canonical-thread");
  assert.equal(checkpoints, 1);
  assert.equal(afterFirst?.workerSnapshotId, "im-worker-checkpoint");
  assert.equal(afterFirst?.workerState, "running");
  assert.equal(liveSandboxId, "sandbox-1", "checkpoint left the sandbox alive");

  // Model a fresh Render process: only Postgres-backed binding state
  // survives, and the still-live worker is reconnected, not re-provisioned.
  currentTime = new Date("2026-08-30T12:31:00.000Z");
  const restartedController = new T3Gateway(
    bindings,
    environments,
    () => "must-not-create-another-thread",
    () => currentTime,
  );
  const reconnectedTurn = await restartedController.send({
    canonicalThreadId: "canonical-thread",
    title: "Restartable thread",
    text: "after the controller restart",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  assert.equal(reconnectedTurn.binding.sandboxId, "sandbox-1");
  assert.equal(reconnectedTurn.binding.workerGeneration ?? 1, 1);
  await restartedController.waitForTerminal({ turn: reconnectedTurn });
  assert.equal(checkpoints, 2);

  // The sandbox dies (Modal 24h ceiling, OOM, ...): the next turn restores
  // the same native thread from the last checkpoint.
  liveSandboxId = null;
  currentTime = new Date("2026-08-30T15:00:00.000Z");
  const resumedTurn = await restartedController.send({
    canonicalThreadId: "canonical-thread",
    title: "Restartable thread",
    text: "three hours later",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.deepEqual(starts, [
    "new:t3-thread-1",
    "continue:t3-thread-1",
    "continue:t3-thread-1",
  ]);
  assert.equal(resumedTurn.binding.t3ThreadId, "t3-thread-1");
  assert.equal(resumedTurn.binding.sandboxId, "sandbox-2");
  assert.equal(resumedTurn.binding.workerGeneration, 2);
  assert.equal(resumedTurn.binding.workerState, "running");
});
test("reports a ready preview from the bound sandbox without provisioning", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const client = {
    baseUrl: "https://t3.example",
  } as T3CommandClient;
  let provisions = 0;
  const connectedPorts: number[] = [];
  const sandbox = {
    id: "sandbox-1",
    process: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    ports: {
      connect: async (port: number) => {
        connectedPorts.push(port);
        return { url: `https://sandbox-${port}.modal.host` };
      },
    },
  } as unknown as SandboxHandle;
  const gateway = new T3Gateway(bindings, {
    async provision() {
      provisions += 1;
      return { sandboxId: "unused", projectId: "unused", client };
    },
    async reconnect() {
      return {
        sandboxId: "sandbox-1",
        projectId: "project-1",
        client,
        sandbox,
      };
    },
  });
  await bindings.bindRecord({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    sandboxId: "sandbox-1",
    projectId: "project-1",
    t3ThreadId: "t3-thread-1",
    baseUrl: "https://t3.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });

  const target = await gateway.inspectPreview({
    canonicalThreadId: "canonical-thread",
  });

  assert.equal(provisions, 0);
  assert.deepEqual(connectedPorts, [3000]);
  assert.equal(target?.state, "ready");
  assert.equal(
    target?.state === "ready" ? target.url : null,
    "https://sandbox-3000.modal.host",
  );
  assert.equal(target?.binding.sandboxId, "sandbox-1");
  assert.equal(
    await gateway.inspectPreview({ canonicalThreadId: "missing-thread" }),
    null,
  );
});

test("inspects preview readiness without starting the development server", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const commands: string[] = [];
  const connectedPorts: number[] = [];
  const sandbox = {
    id: "sandbox-1",
    process: {
      exec: async (command: string) => {
        commands.push(command);
        return { exitCode: 1, stdout: "", stderr: "offline" };
      },
    },
    ports: {
      connect: async (port: number) => {
        connectedPorts.push(port);
        return { url: `https://sandbox-${port}.modal.host` };
      },
    },
  } as unknown as SandboxHandle;
  const client = { baseUrl: "https://t3.example" } as T3CommandClient;
  const gateway = new T3Gateway(bindings, {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      return {
        sandboxId: "sandbox-1",
        projectId: "project-1",
        client,
        sandbox,
      };
    },
  });
  await bindings.bindRecord({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    sandboxId: "sandbox-1",
    projectId: "project-1",
    t3ThreadId: "t3-thread-1",
    baseUrl: "https://t3.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });

  const inspection = await gateway.inspectPreview({
    canonicalThreadId: "canonical-thread",
  });

  assert.equal(inspection?.state, "idle");
  assert.deepEqual(connectedPorts, []);
  assert.match(commands[0] ?? "", /127\.0\.0\.1:3000/);
});

test("reprojects the dev environment before starting preview in a running worker", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const operations: string[] = [];
  const client = { baseUrl: "https://t3.example" } as T3CommandClient;
  const sandbox = {
    id: "sandbox-1",
    workspaceRoot: "/workspace",
    env: {
      set: async () => {
        operations.push("environment");
      },
    },
    process: {
      exec: async () => {
        operations.push("start");
        return { exitCode: 0, stdout: "DEV_ENV_READY", stderr: "" };
      },
    },
    ports: {
      connect: async () => {
        operations.push("port");
        return { url: "https://sandbox-3000.modal.host" };
      },
    },
  } as unknown as SandboxHandle;
  const gateway = new T3Gateway(bindings, {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      return {
        sandboxId: "sandbox-1",
        projectId: "project-1",
        client,
        sandbox,
      };
    },
  });
  await bindings.bindRecord({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    sandboxId: "sandbox-1",
    projectId: "project-1",
    t3ThreadId: "t3-thread-1",
    baseUrl: "https://t3.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    workerState: "running",
    workerGeneration: 1,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });

  const target = await gateway.activatePreview({
    canonicalThreadId: "canonical-thread",
  });

  assert.deepEqual(operations, ["port", "environment", "start"]);
  assert.equal(target?.url, "https://sandbox-3000.modal.host");
});

test("restores a suspended worker and starts its dev server for preview activation", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const phases: string[] = [];
  const commands: Array<{ command: string; cwd?: string }> = [];
  const projectedEnvironment: Array<Record<string, string>> = [];
  const client = { baseUrl: "https://restored-t3.example" } as T3CommandClient;
  const sandbox = {
    id: "sandbox-2",
    workspaceRoot: "/workspace",
    env: {
      set: async (environment: Record<string, string>) => {
        projectedEnvironment.push(environment);
      },
    },
    process: {
      exec: async (command: string, options?: { cwd?: string }) => {
        commands.push({ command, cwd: options?.cwd });
        return { exitCode: 0, stdout: "DEV_ENV_READY", stderr: "" };
      },
    },
    ports: {
      connect: async (port: number) => ({
        url: `https://restored-${port}.modal.host`,
      }),
    },
  } as unknown as SandboxHandle;
  const gateway = new T3Gateway(bindings, {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      throw new T3EnvironmentUnavailableError("sandbox-1");
    },
    async restore() {
      return {
        sandboxId: "sandbox-2",
        projectId: "project-1",
        client,
        sandbox,
      };
    },
  });
  await bindings.bindRecord({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    sandboxId: "sandbox-1",
    projectId: "project-1",
    t3ThreadId: "t3-thread-1",
    baseUrl: "https://t3.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    workerState: "suspended",
    workerSnapshotId: "snapshot-1",
    workerGeneration: 1,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });

  const target = await gateway.activatePreview({
    canonicalThreadId: "canonical-thread",
    onPhase: (phase) => {
      phases.push(phase);
    },
  });

  assert.deepEqual(phases, ["restoring", "starting"]);
  assert.deepEqual(projectedEnvironment, [
    {
      COMPADRE_DEV_PREVIEW_URL: "https://restored-3000.modal.host",
      COMPADRE_DEV_PORT: "3000",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    },
  ]);
  assert.deepEqual(commands, [
    { command: "scripts/compadre-dev-up.sh up", cwd: "/workspace" },
  ]);
  assert.equal(target?.url, "https://restored-3000.modal.host");
  assert.equal(target?.binding.sandboxId, "sandbox-2");
});

test("does not nest directory-index locks inside first-turn environment locks", async () => {
  const persistence = memoryPersistence();
  const locks = new CapacityLockStore(4, 100);
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata, locks);
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
  };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return { sandboxId: "sandbox", projectId: "project", client };
      },
      async reconnect() {
        throw new Error("unused");
      },
    },
    () => `t3-thread-${nextId++}`,
    () => new Date("2026-08-26T15:00:00.000Z"),
    locks,
  );

  const turns = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      gateway.send({
        canonicalThreadId: `canonical-${index}`,
        title: `Concurrent ${index}`,
        text: `Message ${index}`,
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      }),
    ),
  );

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
    async interruptTurn() {
      return 3;
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
    async startNewThread(input: {
      threadId?: string;
      title: string;
      text: string;
    }) {
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
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      throw new Error("unused");
    },
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
          session: {
            status: "ready" as const,
            activeTurnId: null,
            lastError: null,
          },
        },
      };
    },
    async threadSnapshot() {
      throw new Error("unused");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
  } satisfies T3CommandClient;
  const environments: T3EnvironmentConnectionManager = {
    async provision(input) {
      provisioned.push(input.canonicalThreadId);
      return {
        sandboxId: "sandbox-generation",
        projectId: "project-1",
        client,
      };
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const generationId = "11111111-1111-4111-8111-111111111111";
  const ids = [generationId, "native-generation-thread"];
  const gateway = new T3Gateway(bindings, environments, () => ids.shift()!);

  const generated = await gateway.generateText({
    prompt: "Return JSON with a concise title",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    timeoutMs: 30_000,
  });

  assert.equal(
    generated.snapshot.thread.messages[0]?.text,
    '{"title":"Concise title"}',
  );
  assert.deepEqual(provisioned, [generationId]);
  assert.deepEqual(discarded, ["sandbox-generation"]);
  assert.deepEqual(await bindings.list(), []);
});

test("retries internal text generation once in a fresh disposable environment", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const provisioned: string[] = [];
  const discarded: string[] = [];
  let attempts = 0;
  const environments: T3EnvironmentConnectionManager = {
    async provision(input) {
      attempts += 1;
      provisioned.push(input.canonicalThreadId);
      const attempt = attempts;
      const client = {
        baseUrl: `https://t3-${attempt}.example`,
        async startNewThread(input: { threadId?: string }) {
          if (attempt === 1)
            throw new Error("transient worker startup failure");
          return {
            sequence: 10,
            commandId: "command-generate",
            messageId: "message-generate",
            threadId: input.threadId!,
            createdAt: "2026-08-27T15:00:00.000Z",
          };
        },
        async startTurn() {
          throw new Error("unused");
        },
        async interruptTurn() {
          throw new Error("unused");
        },
        async waitForTurnTerminal() {
          return {
            snapshotSequence: 12,
            thread: {
              id: "native-generation-thread-2",
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
                  id: "assistant-generate",
                  role: "assistant" as const,
                  text: '{"title":"Retried title"}',
                  turnId: "turn-generate",
                  streaming: false,
                  createdAt: "2026-08-27T15:00:01.000Z",
                  updatedAt: "2026-08-27T15:00:01.000Z",
                },
              ],
              session: {
                status: "ready" as const,
                activeTurnId: null,
                lastError: null,
              },
            },
          };
        },
        async threadSnapshot() {
          throw new Error("unused");
        },
        async mintPairingCredential() {
          throw new Error("unused");
        },
      } satisfies T3CommandClient;
      return {
        sandboxId: `sandbox-${attempt}`,
        projectId: "project-1",
        client,
      };
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const firstGenerationId = "11111111-1111-4111-8111-111111111111";
  const secondGenerationId = "22222222-2222-4222-8222-222222222222";
  const ids = [
    firstGenerationId,
    "native-generation-thread-1",
    secondGenerationId,
    "native-generation-thread-2",
  ];
  const gateway = new T3Gateway(
    bindings,
    environments,
    () => ids.shift()!,
    () => new Date("2026-08-27T15:00:00.000Z"),
  );

  const generated = await gateway.generateText({
    prompt: "Return JSON with a concise title",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
    timeoutMs: 30_000,
  });

  assert.equal(
    generated.snapshot.thread.messages[0]?.text,
    '{"title":"Retried title"}',
  );
  assert.deepEqual(provisioned, [firstGenerationId, secondGenerationId]);
  assert.deepEqual(discarded, ["sandbox-1", "sandbox-2"]);
});

test("does not retry after a text-generation turn has been dispatched", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  let provisions = 0;
  const discarded: string[] = [];
  const client = {
    baseUrl: "https://t3.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 10,
        commandId: "command-generate",
        messageId: "message-generate",
        threadId: input.threadId!,
        createdAt: "2026-08-27T15:00:00.000Z",
      };
    },
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      throw new Error("unused");
    },
    async waitForTurnTerminal() {
      return {
        snapshotSequence: 12,
        thread: {
          id: "native-generation-thread",
          projectId: "project-1",
          title: "Internal text generation",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
          latestTurn: null,
          messages: [
            {
              id: "message-generate",
              role: "user" as const,
              text: "Return JSON",
              turnId: null,
              streaming: false,
              createdAt: "2026-08-27T15:00:00.000Z",
              updatedAt: "2026-08-27T15:00:00.000Z",
            },
          ],
          session: {
            status: "stopped" as const,
            activeTurnId: null,
            lastError: "provider startup failed",
          },
          activities: [
            {
              id: "activity-failed",
              kind: "provider.turn.start.failed",
              createdAt: "2026-08-27T15:00:00.100Z",
            },
          ],
        },
      };
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
      provisions += 1;
      return {
        sandboxId: `sandbox-${provisions}`,
        projectId: "project-1",
        client,
      };
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const ids = ["generation-1", "native-generation-thread"];
  const gateway = new T3Gateway(bindings, environments, () => ids.shift()!);

  await assert.rejects(
    gateway.generateText({
      prompt: "Return JSON",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      timeoutMs: 30_000,
    }),
    /provider startup failed/,
  );

  assert.equal(provisions, 1);
  assert.deepEqual(discarded, ["sandbox-1"]);
});

test("bounds text-generation provisioning and discards a late environment", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const discarded: string[] = [];
  let resolveProvision!: (connection: {
    sandboxId: string;
    projectId: string;
    client: T3CommandClient;
  }) => void;
  const pendingProvision = new Promise<T3EnvironmentConnection>((resolve) => {
    resolveProvision = resolve;
  });
  const unusedClient = {
    baseUrl: "https://late-t3.example",
    async startNewThread() {
      throw new Error("unused");
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
      return pendingProvision;
    },
    async reconnect() {
      throw new Error("unused");
    },
    async discard(connection) {
      discarded.push(connection.sandboxId);
    },
  };
  const gateway = new T3Gateway(bindings, environments, () => "generation-1");

  const keepEventLoopAlive = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(
      gateway.generateText({
        prompt: "Return JSON",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
        timeoutMs: 20,
      }),
      /aborted|timeout/i,
    );
  } finally {
    clearTimeout(keepEventLoopAlive);
  }

  resolveProvision({
    sandboxId: "sandbox-late",
    projectId: "project-1",
    client: unusedClient,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(discarded, ["sandbox-late"]);
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
      session: {
        status: "ready" as const,
        activeTurnId: null,
        lastError: null,
      },
      activities: [
        { id: "activity-1", type: "command.completed", title: "pwd" },
      ],
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
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      throw new Error("unused");
    },
    async waitForTurnTerminal(input: {
      onSnapshot?(snapshot: typeof terminalSnapshot): void | Promise<void>;
    }) {
      await input.onSnapshot?.(terminalSnapshot);
      return terminalSnapshot;
    },
    async threadSnapshot() {
      throw new Error("Modal should not be read after completion");
    },
    async mintPairingCredential() {
      throw new Error("unused");
    },
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

test("replaces a lost worker (no snapshot) with a fresh native thread on the next turn", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const starts: string[] = [];
  let threadCounter = 0;
  const client: T3CommandClient = {
    baseUrl: "https://t3.example",
    async startNewThread(input) {
      starts.push(`new:${input.threadId}:${input.text}`);
      return {
        sequence: 10,
        commandId: `command-${input.threadId}`,
        messageId: `message-${input.threadId}`,
        threadId: input.threadId!,
        createdAt: "2026-09-01T15:00:00.000Z",
      };
    },
    async startTurn() {
      throw new Error("a lost worker must not receive a turn");
    },
    async interruptTurn() {
      return 1;
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
  let dead = false;
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      return {
        sandboxId: `sandbox-${threadCounter}`,
        projectId: "project-1",
        client,
      };
    },
    async reconnect(binding) {
      if (dead) throw new T3EnvironmentUnavailableError(binding.sandboxId);
      return { sandboxId: binding.sandboxId, projectId: "project-1", client };
    },
  };
  const gateway = new T3Gateway(
    bindings,
    environments,
    () => `t3-thread-${(threadCounter += 1)}`,
    () => new Date("2026-09-01T15:00:00.000Z"),
  );

  const selection = { instanceId: "codex", model: "gpt-5.6-sol" };
  const first = await gateway.send({
    canonicalThreadId: "prod-support-thread",
    title: "Investigate",
    text: "first",
    modelSelection: selection,
    blockedSlackDestination: { channelId: "C1", threadTs: "1.0" },
  });
  assert.equal(first.binding.t3ThreadId, "t3-thread-1");
  assert.equal(first.binding.workerGeneration, 1);

  // The sandbox reaches its lifetime mid-turn: gone, never hibernated.
  dead = false; // reconnect succeeds for the replacement provision path
  dead = true;
  const healed = await gateway.send({
    canonicalThreadId: "prod-support-thread",
    title: "Investigate",
    text: "continue please",
    modelSelection: selection,
  });
  assert.equal(healed.binding.t3ThreadId, "t3-thread-2", "fresh native thread");
  assert.equal(healed.binding.workerGeneration, 2);
  assert.deepEqual(
    healed.binding.blockedSlackDestination,
    { channelId: "C1", threadTs: "1.0" },
    "the protected Slack destination survives the replacement",
  );
  assert.deepEqual(starts, [
    "new:t3-thread-1:first",
    "new:t3-thread-2:continue please",
  ]);
});

test("markWorkerLost parks only the confirmed sandbox and never a restorable one", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const base = {
    canonicalThreadId: "run-thread",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-1",
    projectId: "project-1",
    sandboxId: "sandbox-a",
    baseUrl: "https://t3.example",
    workerState: "running" as const,
    workerGeneration: 1,
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    createdAt: "2026-09-01T13:00:00.000Z",
    updatedAt: "2026-09-01T14:00:00.000Z",
  };
  await bindings.bind(base);
  const environments: T3EnvironmentConnectionManager = {
    async provision() {
      throw new Error("unused");
    },
    async reconnect() {
      throw new Error("unused");
    },
  };
  const gateway = new T3Gateway(bindings, environments);

  await gateway.markWorkerLost("run-thread", "sandbox-other");
  assert.equal((await bindings.get("run-thread"))?.workerState, "running");

  await gateway.markWorkerLost("run-thread", "sandbox-a");
  assert.equal((await bindings.get("run-thread"))?.workerState, "suspended");

  await bindings.bindRecord({
    ...base,
    workerState: "running",
    workerSnapshotId: "im-snapshot",
  });
  await gateway.markWorkerLost("run-thread", "sandbox-a");
  assert.equal(
    (await bindings.get("run-thread"))?.workerState,
    "running",
    "a restorable worker is never parked",
  );
});
