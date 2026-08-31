import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3ThreadBindingStore } from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import type { LockStore } from "./storage.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
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
  const client = {
    baseUrl: "https://t3.example",
    async waitForTurnTerminal() { return completedSnapshot; },
  } as unknown as T3CommandClient;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() { throw new Error("unused"); },
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
  });
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, "run-1");
  await gateway.clearActiveRun("thread-active-run", "older-run");
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, "run-1");
  await gateway.clearActiveRun("thread-active-run", "run-1");
  assert.equal((await bindings.get("thread-active-run"))?.activeRunId, undefined);
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
    undefined,
    undefined,
    undefined,
    { schedule: () => undefined },
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

test("hibernates a terminal worker after its warm lease", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  let currentTime = new Date("2026-08-30T12:00:00.000Z");
  const hibernated: string[] = [];
  const client = {
    baseUrl: "https://worker.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: currentTime.toISOString(),
      };
    },
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      return 2;
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
  const environment = {
    sandboxId: "sandbox-1",
    projectId: "project-1",
    client,
  };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return environment;
      },
      async reconnect() {
        return environment;
      },
      async hibernate(binding) {
        hibernated.push(binding.canonicalThreadId);
        return { snapshotId: "im-checkpoint-1" };
      },
    },
    () => "t3-thread-1",
    () => currentTime,
    undefined,
    undefined,
    undefined,
    { warmLeaseMs: 30 * 60 * 1000, schedule: () => undefined },
  );
  const turn = await gateway.send({
    canonicalThreadId: "canonical-thread",
    title: "Restorable thread",
    text: "work",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await gateway.waitForTerminal({ turn });

  const warm = await bindings.get("canonical-thread");
  assert.equal(warm?.workerState, "warm");
  assert.equal(warm?.warmUntil, "2026-08-30T12:30:00.000Z");

  currentTime = new Date("2026-08-30T12:31:00.000Z");
  await gateway.sweepExpiredWarmWorkers();

  const suspended = await bindings.get("canonical-thread");
  assert.deepEqual(hibernated, ["canonical-thread"]);
  assert.equal(suspended?.workerState, "suspended");
  assert.equal(suspended?.workerSnapshotId, "im-checkpoint-1");
  assert.equal(suspended?.warmUntil, undefined);
});

test("recovers a stale hibernation left by a controller crash", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  await bindings.bind({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-1",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://worker.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    workerState: "hibernating",
    workerGeneration: 1,
    sandboxStartedAt: "2026-08-30T11:00:00.000Z",
    lastActiveAt: "2026-08-30T11:30:00.000Z",
    warmUntil: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T11:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });
  let connectionPassed = true;
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        throw new Error("unused");
      },
      async reconnect() {
        throw new Error("must not require a live T3 server");
      },
      async hibernate(_binding, connection) {
        connectionPassed = connection !== undefined;
        return { snapshotId: "im-recovered-checkpoint" };
      },
    },
    () => "unused",
    () => new Date("2026-08-30T12:11:00.000Z"),
    undefined,
    undefined,
    undefined,
    { schedule: () => undefined },
  );

  await gateway.sweepExpiredWarmWorkers();

  const recovered = await bindings.get("canonical-thread");
  assert.equal(connectionPassed, false);
  assert.equal(recovered?.workerState, "suspended");
  assert.equal(recovered?.workerSnapshotId, "im-recovered-checkpoint");
});

test("finishes an interrupted hibernation before resuming a user turn", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  await bindings.bindRecord({
    canonicalThreadId: "canonical-thread",
    providerInstanceId: "codex",
    t3ThreadId: "t3-thread-1",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://old-worker.example",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    status: "ready",
    workerState: "hibernating",
    workerGeneration: 1,
    sandboxStartedAt: "2026-08-30T11:00:00.000Z",
    lastActiveAt: "2026-08-30T11:30:00.000Z",
    warmUntil: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T11:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });
  const starts: string[] = [];
  const restoredClient = {
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
        createdAt: "2026-08-30T12:01:00.000Z",
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
      async reconnect(binding) {
        throw new T3EnvironmentUnavailableError(binding.sandboxId);
      },
      async hibernate(_binding, connection) {
        assert.equal(connection, undefined);
        return { snapshotId: "im-recovered-checkpoint" };
      },
      async restore(binding) {
        assert.equal(binding.workerSnapshotId, "im-recovered-checkpoint");
        return {
          sandboxId: "sandbox-2",
          projectId: binding.projectId,
          client: restoredClient,
        };
      },
    },
    () => "unused",
    () => new Date("2026-08-30T12:01:00.000Z"),
    undefined,
    undefined,
    undefined,
    { schedule: () => undefined },
  );

  const turn = await gateway.send({
    canonicalThreadId: "canonical-thread",
    title: "Recovered thread",
    text: "continue",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.deepEqual(starts, ["t3-thread-1"]);
  assert.equal(turn.binding.sandboxId, "sandbox-2");
  assert.equal(turn.binding.workerGeneration, 2);
  assert.equal(turn.binding.workerState, "running");
});

test("continues the same native thread after controller restart, hibernation, and restore", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  let currentTime = new Date("2026-08-30T12:00:00.000Z");
  let liveSandboxId: string | null = "sandbox-1";
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
    async hibernate() {
      liveSandboxId = null;
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
  const lifecycle = {
    warmLeaseMs: 30 * 60 * 1000,
    schedule: () => undefined,
  };
  const firstController = new T3Gateway(
    bindings,
    environments,
    () => "t3-thread-1",
    () => currentTime,
    undefined,
    undefined,
    undefined,
    lifecycle,
  );
  const firstTurn = await firstController.send({
    canonicalThreadId: "canonical-thread",
    title: "Restartable thread",
    text: "first",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await firstController.waitForTerminal({ turn: firstTurn });

  // Model a fresh Render process: only Postgres-backed binding state survives.
  currentTime = new Date("2026-08-30T12:31:00.000Z");
  const restartedController = new T3Gateway(
    bindings,
    environments,
    () => "must-not-create-another-thread",
    () => currentTime,
    undefined,
    undefined,
    undefined,
    lifecycle,
  );
  await restartedController.sweepExpiredWarmWorkers();
  assert.equal(
    (await bindings.get("canonical-thread"))?.workerState,
    "suspended",
  );

  currentTime = new Date("2026-08-30T15:00:00.000Z");
  const resumedTurn = await restartedController.send({
    canonicalThreadId: "canonical-thread",
    title: "Restartable thread",
    text: "three hours later",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.deepEqual(starts, ["new:t3-thread-1", "continue:t3-thread-1"]);
  assert.equal(resumedTurn.binding.t3ThreadId, "t3-thread-1");
  assert.equal(resumedTurn.binding.sandboxId, "sandbox-2");
  assert.equal(resumedTurn.binding.workerGeneration, 2);
  assert.equal(resumedTurn.binding.workerState, "running");
});

test("caps the warm lease before Modal's hard sandbox deadline", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const now = new Date("2026-08-30T13:50:00.000Z");
  const client = {
    baseUrl: "https://worker.example",
    async startNewThread(input: { threadId?: string }) {
      return {
        sequence: 1,
        commandId: "command-1",
        messageId: "message-1",
        threadId: input.threadId!,
        createdAt: now.toISOString(),
      };
    },
    async startTurn() {
      throw new Error("unused");
    },
    async interruptTurn() {
      return 2;
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
  const environment = {
    sandboxId: "sandbox-1",
    projectId: "project-1",
    client,
  };
  const gateway = new T3Gateway(
    bindings,
    {
      async provision() {
        return environment;
      },
      async reconnect() {
        return environment;
      },
      async hibernate() {
        return { snapshotId: "unused" };
      },
    },
    () => "t3-thread-1",
    () => now,
    undefined,
    undefined,
    undefined,
    {
      warmLeaseMs: 30 * 60 * 1000,
      maxLiveMs: 2 * 60 * 60 * 1000,
      hibernationSafetyMs: 5 * 60 * 1000,
      schedule: () => undefined,
    },
  );
  const turn = await gateway.send({
    canonicalThreadId: "canonical-thread",
    title: "Near timeout",
    text: "work",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });
  await gateway.waitForTerminal({
    turn: {
      ...turn,
      binding: {
        ...turn.binding,
        sandboxStartedAt: "2026-08-30T12:00:00.000Z",
      },
    },
  });

  assert.equal(
    (await bindings.get("canonical-thread"))?.warmUntil,
    "2026-08-30T13:55:00.000Z",
  );
});

test("resolves a preview from the bound sandbox without provisioning", async () => {
  const persistence = memoryPersistence();
  const bindings = new T3ThreadBindingStore(persistence.stores.metadata);
  const client = {
    baseUrl: "https://t3.example",
  } as T3CommandClient;
  let provisions = 0;
  const connectedPorts: number[] = [];
  const sandbox = {
    id: "sandbox-1",
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

  const target = await gateway.previewTarget({
    canonicalThreadId: "canonical-thread",
  });

  assert.equal(provisions, 0);
  assert.deepEqual(connectedPorts, [3000]);
  assert.equal(target?.url, "https://sandbox-3000.modal.host");
  assert.equal(target?.binding.sandboxId, "sandbox-1");
  assert.equal(
    await gateway.previewTarget({ canonicalThreadId: "missing-thread" }),
    null,
  );
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
          if (attempt === 1) throw new Error("transient worker startup failure");
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
              messages: [{
                id: "assistant-generate",
                role: "assistant" as const,
                text: '{"title":"Retried title"}',
                turnId: "turn-generate",
                streaming: false,
                createdAt: "2026-08-27T15:00:01.000Z",
                updatedAt: "2026-08-27T15:00:01.000Z",
              }],
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
  assert.deepEqual(provisioned, [
    firstGenerationId,
    secondGenerationId,
  ]);
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
          messages: [{
            id: "message-generate",
            role: "user" as const,
            text: "Return JSON",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-27T15:00:00.000Z",
            updatedAt: "2026-08-27T15:00:00.000Z",
          }],
          session: {
            status: "stopped" as const,
            activeTurnId: null,
            lastError: "provider startup failed",
          },
          activities: [{
            id: "activity-failed",
            kind: "provider.turn.start.failed",
            createdAt: "2026-08-27T15:00:00.100Z",
          }],
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
  const pendingProvision = new Promise<T3EnvironmentConnection>(
    (resolve) => {
      resolveProvision = resolve;
    },
  );
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
