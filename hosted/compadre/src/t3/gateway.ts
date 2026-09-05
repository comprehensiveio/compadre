import { captureWorkspaceReview } from "./workspace-review-capture.js";
import { reviewCheckpointForMessage, type T3OrchestrationSnapshot } from "./client.js";
import { randomUUID } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { log, serializeError } from "../logging.js";
import { InMemoryLockStore, type LockStore } from "./storage.js";
import type {
  T3Client,
  T3InputFile,
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";
import { preTurnStartFailure } from "./client.js";
import {
  T3ThreadBindingStore,
  type T3ThreadBinding,
} from "../services/t3-thread-bindings.js";
import { T3ThreadSnapshotStore } from "../services/t3-thread-snapshots.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  collectT3OutputArtifacts,
  type T3OutputArtifact,
} from "./output-artifacts.js";
import type {
  CodexAuthRoute,
  CodexSubscriptionLane,
} from "./codex-subscription-lane.js";
import {
  configureWorkerCodexAuthRoute,
  readWorkerCodexAuthJson,
  readWorkerCodexAuthRoute,
} from "./modal-worker.js";
import {
  authenticatedDevPreviewUrl,
  COMP_DEV_SERVER_PORT,
} from "./dev-environment.js";
import { appendSetupSteering } from "./run-control.js";

export interface T3CommandClient {
  snapshot?(signal?: AbortSignal): Promise<T3OrchestrationSnapshot>;
  readonly baseUrl: string;
  startNewThread(input: {
    threadId?: string;
    projectId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  startTurn(input: {
    threadId: string;
    messageId?: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  interruptTurn(input: {
    threadId: string;
    turnId?: string;
    commandId?: string;
    signal?: AbortSignal;
  }): Promise<number>;
  stopSession?(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<number>;
  waitForTurnTerminal(input: {
    threadId: string;
    minimumSequence: number;
    messageId?: string;
    requestedAt?: string;
    timeoutMs?: number;
    absoluteTimeoutMs?: number;
    requireCheckpoint?: boolean;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  threadSnapshot(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<T3ThreadSnapshot>;
  mintPairingCredential(input: {
    label: string;
    scopes?: ReadonlyArray<string>;
    signal?: AbortSignal;
  }): Promise<{ id: string; credential: string; expiresAt: string }>;
}

export interface T3EnvironmentConnection {
  sandboxId: string;
  projectId: string;
  client: T3CommandClient;
  sandbox?: SandboxHandle;
}

export interface T3EnvironmentConnectionManager {
  provision(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    blockedSlackDestination?: {
      channelId: string;
      threadTs: string;
    };
  }): Promise<T3EnvironmentConnection>;
  reconnect(binding: T3ThreadBinding): Promise<T3EnvironmentConnection>;
  restore?(binding: T3ThreadBinding): Promise<T3EnvironmentConnection>;
  /** Live filesystem snapshot; the worker keeps running. */
  checkpoint?(
    binding: T3ThreadBinding,
    connection?: T3EnvironmentConnection,
  ): Promise<{ snapshotId: string }>;
  discard?(connection: T3EnvironmentConnection): Promise<void>;
}

export type T3PreviewInspection =
  | {
      state: "ready";
      binding: T3ThreadBinding;
      url: string;
    }
  | {
      state: "idle";
      binding: T3ThreadBinding;
      reason: "worker_unavailable" | "server_stopped";
    };

export class T3EnvironmentUnavailableError extends Error {
  readonly canonicalThreadId?: string;
  readonly reason?: string;

  constructor(
    readonly sandboxId: string,
    context: { canonicalThreadId?: string; reason?: string } = {},
  ) {
    super(
      `T3 Modal sandbox ${sandboxId} is unavailable${
        context.reason ? ` (${context.reason})` : ""
      }`,
    );
    this.name = "T3EnvironmentUnavailableError";
    this.canonicalThreadId = context.canonicalThreadId;
    this.reason = context.reason;
  }
}

export interface T3WorkerLifecycleOptions {
  /** Modal sandbox lifetime; the only lifecycle clock (default 24 h). */
  maxLiveMs?: number;
}

export interface T3GatewayTurn {
  binding: T3ThreadBinding;
  dispatch: T3TurnDispatch;
}

export interface T3GatewayTextGeneration {
  dispatch: T3TurnDispatch;
  snapshot: T3ThreadSnapshot;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("T3 text generation was aborted");
}

/**
 * Bounds an operation that cannot itself be cancelled while still cleaning up
 * a resource if it becomes available after the caller's deadline.
 */
function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateResult?: (result: T) => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (result) => {
        if (settled) {
          if (onLateResult) {
            void Promise.resolve(onLateResult(result)).catch((error) => {
              console.error("[t3-text-generation] late cleanup failed", {
                errorName: error instanceof Error ? error.name : typeof error,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            });
          }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface T3PreviewTarget {
  binding: T3ThreadBinding;
  url: string;
}

const DEFAULT_T3_HOSTED_APP_URL = "https://app.t3.codes";
const DEFAULT_WORKER_MAX_LIVE_MS = 24 * 60 * 60 * 1000;
/** Stop watching slightly before the sandbox's hard lifetime. */
const WATCH_LIFETIME_SAFETY_MS = 5 * 60 * 1000;
const workerLifecycleTransitions = metrics
  .getMeter("compadre.runtime")
  .createCounter("compadre.t3.worker.lifecycle.transitions", {
    description: "Native T3 worker lifecycle transitions",
  });
const codexAuthRouteSelections = metrics
  .getMeter("compadre.runtime")
  .createCounter("compadre.codex.auth.route.selections", {
    description: "Codex authentication route selections",
  });
const codexAuthHandoffPhases = metrics
  .getMeter("compadre.runtime")
  .createCounter("compadre.codex.auth.handoff.phases", {
    description: "Codex authentication handoff phase outcomes",
  });
const codexAuthHandoffDuration = metrics
  .getMeter("compadre.runtime")
  .createHistogram("compadre.codex.auth.handoff.duration", {
    unit: "ms",
    description: "Codex authentication handoff phase duration",
  });

type CodexAuthHandoffPhase =
  | "provider_session_stop"
  | "worker_auth_configure"
  | "api_route_release"
  | "refreshed_auth_read"
  | "refreshed_auth_persist"
  | "worker_api_reset";

export function buildT3HostedThreadUrl(input: {
  hostedAppUrl: string;
  environmentUrl: string;
  pairingCredential: string;
  threadId: string;
  label: string;
}): string {
  const url = new URL("/pair", input.hostedAppUrl);
  url.searchParams.set("host", input.environmentUrl);
  url.searchParams.set("label", input.label);
  url.searchParams.set("threadId", input.threadId);
  url.hash = new URLSearchParams([
    ["token", input.pairingCredential],
  ]).toString();
  return url.toString();
}

/**
 * Provider-neutral entry point used by Slack, HTTP, and the hosted UI.
 * T3 remains responsible for native Codex/Claude lifecycle and transcript
 * projection; this class owns only external-thread routing.
 */
export class T3Gateway {
  private readonly maxLiveMs: number;

  constructor(
    private readonly bindings: T3ThreadBindingStore,
    private readonly environments: T3EnvironmentConnectionManager,
    private readonly idFactory: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly locks: LockStore = new InMemoryLockStore(),
    private readonly hostedAppUrl: string = process.env.COMPADRE_T3_HOSTED_APP_URL?.trim() ||
      DEFAULT_T3_HOSTED_APP_URL,
    private readonly snapshots?: T3ThreadSnapshotStore,
    workerLifecycle: T3WorkerLifecycleOptions = {},
    private readonly codexSubscriptionLane?: CodexSubscriptionLane,
    private readonly codexApiAuthJson?: string,
  ) {
    this.maxLiveMs = workerLifecycle.maxLiveMs ?? DEFAULT_WORKER_MAX_LIVE_MS;
    if (!Number.isFinite(this.maxLiveMs) || this.maxLiveMs <= 0) {
      throw new Error("T3 worker maximum live time must be a positive number");
    }
  }

  private lockKey(canonicalThreadId: string) {
    return `compadre:t3-environment:${canonicalThreadId}`;
  }

  private async observeCodexAuthHandoff<T>(input: {
    canonicalThreadId: string;
    runId: string;
    route: CodexAuthRoute;
    phase: CodexAuthHandoffPhase;
    failureLaneState:
      | "retained_for_safety"
      | "unaffected"
      | "released_worker_stopped";
    operation(): Promise<T>;
  }): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await input.operation();
      const durationMs = Date.now() - startedAt;
      codexAuthHandoffPhases.add(1, {
        route: input.route,
        phase: input.phase,
        outcome: "success",
      });
      codexAuthHandoffDuration.record(durationMs, {
        route: input.route,
        phase: input.phase,
        outcome: "success",
      });
      log.info(
        {
          canonicalThreadId: input.canonicalThreadId,
          runId: input.runId,
          codexAuthRoute: input.route,
          codexAuthHandoffPhase: input.phase,
          durationMs,
        },
        "Codex auth handoff phase completed",
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      codexAuthHandoffPhases.add(1, {
        route: input.route,
        phase: input.phase,
        outcome: "error",
        lane_state: input.failureLaneState,
      });
      codexAuthHandoffDuration.record(durationMs, {
        route: input.route,
        phase: input.phase,
        outcome: "error",
      });
      log.error(
        {
          canonicalThreadId: input.canonicalThreadId,
          runId: input.runId,
          codexAuthRoute: input.route,
          codexAuthHandoffPhase: input.phase,
          codexLaneState: input.failureLaneState,
          durationMs,
          ...serializeError(error),
        },
        "Codex auth handoff phase failed",
      );
      throw error;
    }
  }

  private recordWorkerTransition(
    event: string,
    binding: T3ThreadBinding,
    attributes: Record<string, unknown> = {},
  ): void {
    workerLifecycleTransitions.add(1, {
      event,
      provider: binding.providerInstanceId,
      generation: binding.workerGeneration ?? 1,
    });
    log.info(
      {
        event,
        canonicalThreadId: binding.canonicalThreadId,
        sandboxId: binding.sandboxId,
        provider: binding.providerInstanceId,
        generation: binding.workerGeneration ?? 1,
        workerState: binding.workerState,
        ...attributes,
      },
      `t3 worker lifecycle: ${event}`,
    );
  }

  private async connectForTurn(initialBinding: T3ThreadBinding): Promise<{
    binding: T3ThreadBinding;
    environment: T3EnvironmentConnection;
  }> {
    let binding = initialBinding;
    if (binding.workerState !== "suspended") {
      try {
        return {
          binding,
          environment: await this.environments.reconnect(binding),
        };
      } catch (error) {
        if (!(error instanceof T3EnvironmentUnavailableError)) throw error;
      }
    }
    if (!binding.workerSnapshotId || !this.environments.restore) {
      const reason = !binding.workerSnapshotId
        ? "no snapshot to restore"
        : "restore unsupported";
      log.warn(
        {
          canonicalThreadId: binding.canonicalThreadId,
          sandboxId: binding.sandboxId,
          generation: binding.workerGeneration ?? 1,
          workerState: binding.workerState,
          reason,
        },
        "t3 worker unavailable for turn",
      );
      throw new T3EnvironmentUnavailableError(binding.sandboxId, {
        canonicalThreadId: binding.canonicalThreadId,
        reason,
      });
    }

    const restoring: T3ThreadBinding = {
      ...binding,
      workerState: "restoring",
      updatedAt: this.now().toISOString(),
    };
    await this.bindings.bindRecord(restoring);
    this.recordWorkerTransition("restore.started", restoring, {
      snapshotId: restoring.workerSnapshotId,
    });
    try {
      const environment = await this.environments.restore(restoring);
      const timestamp = this.now().toISOString();
      const restored: T3ThreadBinding = {
        ...restoring,
        sandboxId: environment.sandboxId,
        baseUrl: environment.client.baseUrl,
        workerState: "running",
        workerGeneration: (binding.workerGeneration ?? 1) + 1,
        sandboxStartedAt: timestamp,
        lastActiveAt: timestamp,
        warmUntil: undefined,
        status: "ready",
        updatedAt: timestamp,
      };
      await this.bindings.bindRecord(restored);
      this.recordWorkerTransition("restore.completed", restored, {
        previousSandboxId: binding.sandboxId,
      });
      return { binding: restored, environment };
    } catch (error) {
      await this.bindings
        .bindRecord({
          ...binding,
          workerState: "suspended",
          status: "unavailable",
          updatedAt: this.now().toISOString(),
        })
        .catch(() => undefined);
      this.recordWorkerTransition("restore.failed", binding, {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * Runs provider-backed metadata generation outside the durable user thread
   * directory. The temporary T3 environment is always discarded, so title,
   * branch, commit, and PR generation cannot appear as user conversations.
   */
  async generateText(input: {
    prompt: string;
    modelSelection: T3ModelSelection;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<T3GatewayTextGeneration> {
    if (!this.environments.discard) {
      throw new Error("T3 text generation requires disposable environments");
    }
    const deadline = this.now().getTime() + input.timeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (input.signal?.aborted) throw input.signal.reason;
      const generationId = this.idFactory();
      let environment: T3EnvironmentConnection | undefined;
      let phase: "provision" | "start" | "wait" = "provision";
      try {
        const remainingMs = Math.max(1, deadline - this.now().getTime());
        const deadlineSignal = AbortSignal.timeout(remainingMs);
        const attemptSignal = input.signal
          ? AbortSignal.any([input.signal, deadlineSignal])
          : deadlineSignal;
        environment = await awaitWithAbort(
          this.environments.provision({
            // idFactory defaults to randomUUID. Keep that UUID intact because
            // worker environment projections (notably dev-backup access) use
            // the canonical thread id as a scoped security boundary.
            canonicalThreadId: generationId,
            providerInstanceId: input.modelSelection.instanceId,
          }),
          attemptSignal,
          (lateEnvironment) => this.environments.discard!(lateEnvironment),
        );
        phase = "start";
        const threadId = this.idFactory();
        const dispatch = await awaitWithAbort(
          environment.client.startNewThread({
            threadId,
            projectId: environment.projectId,
            title: "Internal text generation",
            text: input.prompt,
            modelSelection: input.modelSelection,
            signal: attemptSignal,
          }),
          attemptSignal,
        );
        phase = "wait";
        const waitRemainingMs = Math.max(1, deadline - this.now().getTime());
        const snapshot = await environment.client.waitForTurnTerminal({
          threadId,
          minimumSequence: dispatch.sequence,
          messageId: dispatch.messageId,
          requestedAt: dispatch.createdAt,
          timeoutMs: waitRemainingMs,
          signal: attemptSignal,
        });
        const state = snapshot.thread.latestTurn?.state;
        const startFailure = preTurnStartFailure(snapshot, dispatch.messageId);
        if (state === "error" || startFailure) {
          throw new Error(
            startFailure?.message ||
              snapshot.thread.session?.lastError ||
              "T3 text generation failed",
          );
        }
        if (state === "interrupted") {
          throw new Error("T3 text generation was interrupted");
        }
        return { dispatch, snapshot };
      } catch (error) {
        lastError = error;
        if (
          phase === "wait" ||
          attempt >= 2 ||
          input.signal?.aborted ||
          this.now().getTime() >= deadline
        ) {
          throw error;
        }
        console.warn("[t3-text-generation] retrying disposable environment", {
          attempt,
          providerInstanceId: input.modelSelection.instanceId,
          model: input.modelSelection.model,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (environment) await this.environments.discard(environment);
      }
    }
    throw lastError;
  }

  async send(input: {
    runId?: string;
    canonicalThreadId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    blockedSlackDestination?: {
      channelId: string;
      threadTs: string;
    };
    loadInitialSteering?: () => Promise<ReadonlyArray<string>>;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn> {
    const turn = await this.locks.withLock(
      this.lockKey(input.canonicalThreadId),
      async (lockSignal) => {
        if (lockSignal.aborted) throw lockSignal.reason;
        return this.sendUnlocked(input);
      },
    );
    // Never acquire the global directory-index lock while the per-thread lock
    // is held. Four concurrent first turns previously exhausted the four-client
    // Postgres advisory-lock pool and deadlocked here permanently.
    await this.bindings.ensureIndexed(input.canonicalThreadId);
    return turn;
  }

  private async sendUnlocked(input: {
    runId?: string;
    canonicalThreadId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    blockedSlackDestination?: {
      channelId: string;
      threadTs: string;
    };
    loadInitialSteering?: () => Promise<ReadonlyArray<string>>;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn> {
    const providerInstanceId = input.modelSelection.instanceId;
    const existing = await this.bindings.get(input.canonicalThreadId);
    if (existing) {
      if (existing.providerInstanceId !== providerInstanceId) {
        throw new Error(
          `This T3 thread is already using ${existing.providerInstanceId}; start a new thread to use ${providerInstanceId}.`,
        );
      }
      if (input.blockedSlackDestination && !existing.blockedSlackDestination) {
        throw new Error(
          "This existing T3 environment was not provisioned with a protected Slack destination; start a new thread.",
        );
      }
      if (
        input.blockedSlackDestination &&
        existing.blockedSlackDestination &&
        (input.blockedSlackDestination.channelId !==
          existing.blockedSlackDestination.channelId ||
          input.blockedSlackDestination.threadTs !==
            existing.blockedSlackDestination.threadTs)
      ) {
        throw new Error(
          "This T3 environment is already assigned to a different Slack destination.",
        );
      }
      let connected;
      try {
        connected = await this.connectForTurn(existing);
      } catch (error) {
        if (
          !(error instanceof T3EnvironmentUnavailableError) ||
          existing.workerSnapshotId
        ) {
          throw error;
        }
        // The worker died without a restorable checkpoint (sandbox lifetime
        // reached mid-turn, or a crash before the first checkpoint). The
        // worker-local transcript is gone, but central T3 remains the
        // canonical conversation, so replace the worker instead of leaving
        // the thread permanently unreachable.
        this.recordWorkerTransition("worker.lost", existing, {
          phase: "send",
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return this.provisionTurn(
          {
            ...input,
            blockedSlackDestination:
              input.blockedSlackDestination ?? existing.blockedSlackDestination,
          },
          existing,
        );
      }
      const environment = connected.environment;
      await this.prepareCodexAuth(environment, connected.binding, input.runId);
      const dispatch = await environment.client.startTurn({
        threadId: connected.binding.t3ThreadId,
        text: input.text,
        displayText: input.displayText,
        modelSelection: input.modelSelection,
        inputFiles: input.inputFiles,
        signal: input.signal,
      });
      const updated: T3ThreadBinding = {
        ...connected.binding,
        title: connected.binding.title ?? input.title,
        status: "working",
        workerState: "running",
        lastActiveAt: this.now().toISOString(),
        warmUntil: undefined,
        modelSelection: input.modelSelection,
        updatedAt: this.now().toISOString(),
      };
      await this.bindings.bindRecord(updated);
      return { binding: updated, dispatch };
    }

    return this.provisionTurn(input);
  }

  /** Provision a worker and first turn; `replacing` heals a lost worker. */
  private async provisionTurn(
    input: {
      runId?: string;
      canonicalThreadId: string;
      title: string;
      text: string;
      displayText?: string;
      modelSelection: T3ModelSelection;
      inputFiles?: ReadonlyArray<T3InputFile>;
      blockedSlackDestination?: {
        channelId: string;
        threadTs: string;
      };
      loadInitialSteering?: () => Promise<ReadonlyArray<string>>;
      signal?: AbortSignal;
    },
    replacing?: T3ThreadBinding,
  ): Promise<T3GatewayTurn> {
    const providerInstanceId = input.modelSelection.instanceId;
    const environment = await this.environments.provision({
      canonicalThreadId: input.canonicalThreadId,
      providerInstanceId,
      blockedSlackDestination: input.blockedSlackDestination,
    });
    try {
      const t3ThreadId = this.idFactory();
      await this.prepareCodexAuth(
        environment,
        {
          canonicalThreadId: input.canonicalThreadId,
          providerInstanceId,
          t3ThreadId,
        },
        input.runId,
      );
      const initialSteering = await input.loadInitialSteering?.() ?? [];
      const dispatch = await environment.client.startNewThread({
        threadId: t3ThreadId,
        projectId: environment.projectId,
        title: input.title,
        text: appendSetupSteering(
          input.text,
          initialSteering.map((text) => ({ text })),
        ),
        displayText: input.displayText,
        inputFiles: input.inputFiles,
        modelSelection: input.modelSelection,
        signal: input.signal,
      });
      const timestamp = this.now().toISOString();
      const binding: T3ThreadBinding = {
        canonicalThreadId: input.canonicalThreadId,
        providerInstanceId,
        t3ThreadId,
        projectId: environment.projectId,
        sandboxId: environment.sandboxId,
        baseUrl: environment.client.baseUrl,
        workerState: "running",
        workerGeneration: (replacing?.workerGeneration ?? 0) + 1,
        sandboxStartedAt: timestamp,
        lastActiveAt: timestamp,
        modelSelection: input.modelSelection,
        blockedSlackDestination: input.blockedSlackDestination,
        title: replacing?.title ?? input.title,
        status: "working",
        createdAt: replacing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (replacing) await this.bindings.replaceLostWorkerRecord(binding);
      else await this.bindings.bindRecord(binding);
      this.recordWorkerTransition(
        replacing ? "provision.replaced" : "provision.completed",
        binding,
      );
      return { binding, dispatch };
    } catch (error) {
      await this.environments.discard?.(environment).catch(() => undefined);
      throw error;
    }
  }

  /** Queue input into the provider turn already running in this worker. */
  async steer(input: {
    canonicalThreadId: string;
    id: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    return this.locks.withLock(
      this.lockKey(input.canonicalThreadId),
      async (lockSignal) => {
        if (lockSignal.aborted) throw lockSignal.reason;
        const binding = await this.bindings.get(input.canonicalThreadId);
        if (!binding || binding.status !== "working") return false;
        const environment = await this.environments.reconnect(binding);
        const snapshot = await environment.client.threadSnapshot(
          binding.t3ThreadId,
          input.signal,
        );
        if (snapshot.thread.latestTurn?.state !== "running") return false;
        await environment.client.startTurn({
          threadId: binding.t3ThreadId,
          messageId: input.id,
          text: input.text,
          modelSelection: binding.modelSelection,
          signal: input.signal,
        });
        const timestamp = this.now().toISOString();
        await this.bindings.bindRecord({
          ...binding,
          status: "working",
          lastActiveAt: timestamp,
          updatedAt: timestamp,
        });
        return true;
      },
    );
  }

  private async waitForSessionStopped(
    environment: T3EnvironmentConnection,
    threadId: string,
  ): Promise<void> {
    if (!environment.client.stopSession) {
      throw new Error("T3 worker does not support provider-session stop");
    }
    await environment.client.stopSession({ threadId });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const snapshot = await environment.client.threadSnapshot(threadId);
      if (
        snapshot.thread.session === null ||
        snapshot.thread.session.status === "stopped"
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out stopping Codex session for ${threadId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async prepareCodexAuth(
    environment: T3EnvironmentConnection,
    binding: Pick<
      T3ThreadBinding,
      "canonicalThreadId" | "providerInstanceId" | "t3ThreadId"
    >,
    runId?: string,
  ): Promise<void> {
    if (
      binding.providerInstanceId !== "codex" ||
      !runId ||
      !this.codexSubscriptionLane?.managed
    ) {
      return;
    }
    if (!environment.sandbox) {
      throw new Error("Codex auth routing requires the Modal sandbox handle");
    }
    const claim = await this.codexSubscriptionLane
      .claim({
        canonicalThreadId: binding.canonicalThreadId,
        runId,
      })
      .catch((error) => {
        log.warn(
          {
            canonicalThreadId: binding.canonicalThreadId,
            runId,
            ...serializeError(error),
          },
          "Codex subscription lane unavailable; using API auth",
        );
        return {
          route: "api" as const,
          reason: "lane_error" as const,
          requiresConfiguration: true,
          authJson: undefined,
        };
      });
    const currentRoute = await readWorkerCodexAuthRoute(environment.sandbox);
    const routeChanged = currentRoute !== claim.route;
    codexAuthRouteSelections.add(1, {
      route: claim.route,
      reason: claim.reason,
      route_changed: routeChanged,
    });
    log.info(
      {
        canonicalThreadId: binding.canonicalThreadId,
        runId,
        codexAuthRoute: claim.route,
        codexAuthRouteReason: claim.reason,
        routeChanged,
      },
      "Codex auth route selected",
    );
    if (!routeChanged) return;
    // A provider process may cache credentials. Stop it before changing the
    // file so one process can never straddle API and subscription billing.
    const existing = await environment.client
      .threadSnapshot(binding.t3ThreadId)
      .catch(() => null);
    if (
      existing?.thread.session &&
      existing.thread.session.status !== "stopped"
    ) {
      await this.observeCodexAuthHandoff({
        canonicalThreadId: binding.canonicalThreadId,
        runId,
        route: claim.route,
        phase: "provider_session_stop",
        failureLaneState:
          claim.route === "subscription" ? "retained_for_safety" : "unaffected",
        operation: () =>
          this.waitForSessionStopped(environment, binding.t3ThreadId),
      });
    }
    await this.observeCodexAuthHandoff({
      canonicalThreadId: binding.canonicalThreadId,
      runId,
      route: claim.route,
      phase: "worker_auth_configure",
      failureLaneState:
        claim.route === "subscription" ? "retained_for_safety" : "unaffected",
      operation: () =>
        configureWorkerCodexAuthRoute(
          environment.sandbox!,
          claim.route,
          claim.route === "subscription"
            ? claim.authJson
            : this.codexApiAuthJson,
        ),
    });
  }

  async releaseCodexAuth(input: {
    canonicalThreadId: string;
    runId: string;
  }): Promise<void> {
    if (!this.codexSubscriptionLane?.enabled) return;
    await this.locks.withLock(
      this.lockKey(input.canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        await this.releaseCodexAuthUnlocked(input);
      },
    );
  }

  private async releaseCodexAuthUnlocked(input: {
    canonicalThreadId: string;
    runId: string;
  }): Promise<void> {
    if (!this.codexSubscriptionLane?.enabled) return;
    const route = await this.codexSubscriptionLane.routeForRun(input);
    if (!route) return;
    if (route === "api") {
      await this.observeCodexAuthHandoff({
        ...input,
        route,
        phase: "api_route_release",
        failureLaneState: "unaffected",
        operation: () => this.codexSubscriptionLane!.release(input),
      });
      return;
    }
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding || binding.providerInstanceId !== "codex") return;
    const environment = await this.environments.reconnect(binding);
    if (!environment.sandbox) {
      throw new Error("Codex auth release requires the Modal sandbox handle");
    }
    await this.observeCodexAuthHandoff({
      ...input,
      route,
      phase: "provider_session_stop",
      failureLaneState: "retained_for_safety",
      operation: () =>
        this.waitForSessionStopped(environment, binding.t3ThreadId),
    });
    const refreshedAuthJson = await this.observeCodexAuthHandoff({
      ...input,
      route,
      phase: "refreshed_auth_read",
      failureLaneState: "retained_for_safety",
      operation: () => readWorkerCodexAuthJson(environment.sandbox!),
    });
    const released = await this.observeCodexAuthHandoff({
      ...input,
      route,
      phase: "refreshed_auth_persist",
      failureLaneState: "retained_for_safety",
      operation: () =>
        this.codexSubscriptionLane!.release({
          ...input,
          refreshedAuthJson,
        }),
    });
    if (released) {
      // Return the idle worker to the unambiguous default before another turn.
      await this.observeCodexAuthHandoff({
        ...input,
        route,
        phase: "worker_api_reset",
        failureLaneState: "released_worker_stopped",
        operation: () =>
          configureWorkerCodexAuthRoute(
            environment.sandbox!,
            "api",
            this.codexApiAuthJson,
          ),
      });
      log.info(
        {
          canonicalThreadId: input.canonicalThreadId,
          runId: input.runId,
          codexAuthRoute: "subscription",
          codexLaneState: "available",
        },
        "Codex subscription lane released",
      );
    }
  }

  list(): Promise<T3ThreadBinding[]> {
    return this.bindings.list();
  }

  async snapshot(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3ThreadBinding;
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const archived = await this.snapshots?.get(input.canonicalThreadId);
    if (archived && binding.status !== "working") {
      return { binding, snapshot: archived.snapshot, source: "central" };
    }
    try {
      const environment = await this.environments.reconnect(binding);
      const snapshot = await environment.client.threadSnapshot(
        binding.t3ThreadId,
        input.signal,
      );
      await this.snapshots?.save(binding, snapshot);
      const latestState = snapshot.thread.latestTurn?.state;
      const startFailure = preTurnStartFailure(snapshot);
      const status =
        latestState === "running"
          ? "working"
          : latestState === "error"
            ? "error"
            : startFailure
              ? "error"
              : latestState === "interrupted"
                ? "interrupted"
                : "ready";
      const updated: T3ThreadBinding = {
        ...binding,
        title: snapshot.thread.title || binding.title,
        modelSelection: snapshot.thread.modelSelection,
        status,
        // Reading a selected transcript is not new thread activity. Keeping
        // this stable lets the central directory signal real cross-surface
        // changes without creating a snapshot/poll feedback loop.
        updatedAt: binding.updatedAt,
        baseUrl: environment.client.baseUrl,
      };
      await this.bindings.bind(updated);
      return { binding: updated, snapshot, source: "worker" };
    } catch (error) {
      const unavailable: T3ThreadBinding = {
        ...binding,
        status: "unavailable",
        updatedAt: this.now().toISOString(),
      };
      await this.bindings.bind(unavailable).catch(() => undefined);
      if (archived) {
        return {
          binding: unavailable,
          snapshot: archived.snapshot,
          source: "central",
        };
      }
      throw error;
    }
  }

  async open(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{ binding: T3ThreadBinding; pairingUrl: string } | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const environment = await this.environments.reconnect(binding);
    const pairing = await environment.client.mintPairingCredential({
      label: `Compadre thread ${binding.canonicalThreadId}`,
      signal: input.signal,
    });
    return {
      binding,
      pairingUrl: buildT3HostedThreadUrl({
        hostedAppUrl: this.hostedAppUrl,
        environmentUrl: environment.client.baseUrl,
        pairingCredential: pairing.credential,
        threadId: binding.t3ThreadId,
        label: binding.title ?? `Compadre thread ${binding.canonicalThreadId}`,
      }),
    };
  }

  /** Read-only preview readiness check. It never restores a worker or starts processes. */
  async inspectPreview(input: {
    canonicalThreadId: string;
  }): Promise<T3PreviewInspection | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    let environment: T3EnvironmentConnection;
    try {
      environment = await this.environments.reconnect(binding);
    } catch (error) {
      if (!(error instanceof T3EnvironmentUnavailableError)) throw error;
      return { state: "idle", binding, reason: "worker_unavailable" };
    }
    if (!environment.sandbox) {
      return { state: "idle", binding, reason: "server_stopped" };
    }
    const ready = await environment.sandbox.process.exec(
      "curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3000/ >/dev/null",
    );
    if (ready.exitCode !== 0) {
      return { state: "idle", binding, reason: "server_stopped" };
    }
    const channel = await environment.sandbox.ports.connect(3000);
    return { state: "ready", binding, url: channel.url };
  }

  /** Restore/reconnect the bound worker and idempotently start its Comp dev stack. */
  async activatePreview(input: {
    canonicalThreadId: string;
    onPhase?(phase: "restoring" | "starting"): void | Promise<void>;
  }): Promise<T3PreviewTarget | null> {
    return this.locks.withLock(
      this.lockKey(input.canonicalThreadId),
      async (lockSignal) => {
        if (lockSignal.aborted) throw lockSignal.reason;
        const binding = await this.bindings.get(input.canonicalThreadId);
        if (!binding) return null;
        await input.onPhase?.("restoring");
        const connected = await this.connectForTurn(binding);
        const sandbox = connected.environment.sandbox;
        if (!sandbox) {
          throw new Error(
            `T3 Modal sandbox ${connected.binding.sandboxId} does not expose a development server`,
          );
        }
        await input.onPhase?.("starting");
        const channel = await sandbox.ports.connect(COMP_DEV_SERVER_PORT);
        const previewUrl =
          authenticatedDevPreviewUrl({
            ...process.env,
            COMPADRE_CANONICAL_THREAD_ID: connected.binding.canonicalThreadId,
          }) ?? channel.url.replace(/\/$/, "");
        await sandbox.env.set({
          COMPADRE_DEV_PREVIEW_URL: previewUrl,
          COMPADRE_DEV_PORT: String(COMP_DEV_SERVER_PORT),
          AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        });
        const started = await sandbox.process.exec(
          "scripts/compadre-dev-up.sh up",
          { cwd: sandbox.workspaceRoot ?? "/workspace" },
        );
        if (started.exitCode !== 0) {
          const detail = (started.stderr || started.stdout)
            .trim()
            .slice(-2_000);
          throw new Error(
            `Comp development server failed to start${detail ? `: ${detail}` : ""}`,
          );
        }
        return { binding: connected.binding, url: channel.url };
      },
    );
  }

  async cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const environment = await this.environments.reconnect(binding);
    return environment.client.interruptTurn({
      threadId: binding.t3ThreadId,
      turnId: input.turnId,
      signal: input.signal,
    });
  }

  async waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    absoluteTimeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot> {
    const environment = await this.environments.reconnect(input.turn.binding);
    const workerStartedAt = Date.parse(
      input.turn.binding.sandboxStartedAt ?? input.turn.binding.createdAt,
    );
    const remainingWorkerLifetime = Number.isFinite(workerStartedAt)
      ? Math.max(
          1,
          workerStartedAt +
            this.maxLiveMs -
            WATCH_LIFETIME_SAFETY_MS -
            this.now().getTime(),
        )
      : this.maxLiveMs - WATCH_LIFETIME_SAFETY_MS;
    const snapshot = await environment.client.waitForTurnTerminal({
      threadId: input.turn.binding.t3ThreadId,
      minimumSequence: input.turn.dispatch.sequence,
      messageId: input.turn.dispatch.messageId,
      requestedAt: input.turn.dispatch.createdAt,
      timeoutMs: input.timeoutMs,
      absoluteTimeoutMs: Math.min(
        input.absoluteTimeoutMs ?? remainingWorkerLifetime,
        remainingWorkerLifetime,
      ),
      signal: input.signal,
      onSnapshot: async (nextSnapshot) => {
        await this.snapshots?.save(input.turn.binding, nextSnapshot);
        await input.onSnapshot?.(nextSnapshot);
      },
    });
    await this.snapshots?.save(input.turn.binding, snapshot);
    const latestState = snapshot.thread.latestTurn?.state;
    const startFailure = preTurnStartFailure(
      snapshot,
      input.turn.dispatch.messageId,
    );
    const timestamp = this.now().toISOString();
    // The turn was dispatched before its durable activeRunId marker was
    // written. Merge terminal state onto the latest binding so this waiter
    // cannot erase a newer marker with its stale pre-dispatch copy.
    const currentBinding =
      (await this.bindings.get(input.turn.binding.canonicalThreadId)) ??
      input.turn.binding;
    const updated: T3ThreadBinding = {
      ...currentBinding,
      title: snapshot.thread.title || currentBinding.title,
      modelSelection: snapshot.thread.modelSelection,
      status:
        latestState === "error" || startFailure
          ? "error"
          : latestState === "interrupted"
            ? "interrupted"
            : "ready",
      lastActiveAt: timestamp,
      updatedAt: timestamp,
    };
    await this.bindings.bind(updated);
    // The worker stays alive for follow-up turns (its 24 h sandbox lifetime
    // is the only lifecycle clock), but a best-effort checkpoint after every
    // terminal turn keeps the thread recoverable from that point on.
    if (this.environments.checkpoint) {
      try {
        const checkpoint = await this.environments.checkpoint(
          updated,
          environment,
        );
        const checkpointed: T3ThreadBinding = {
          ...updated,
          workerSnapshotId: checkpoint.snapshotId,
          updatedAt: this.now().toISOString(),
        };
        await this.bindings.bindRecord(checkpointed);
        this.recordWorkerTransition("checkpoint.completed", checkpointed, {
          snapshotId: checkpoint.snapshotId,
        });
      } catch (error) {
        this.recordWorkerTransition("checkpoint.failed", updated, {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    return snapshot;
  }

  async markActiveRun(canonicalThreadId: string, runId: string): Promise<void> {
    await this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const binding = await this.bindings.get(canonicalThreadId);
        if (!binding)
          throw new Error(`T3 thread ${canonicalThreadId} is not bound`);
        await this.bindings.bindRecord({
          ...binding,
          activeRunId: runId,
          status: "working",
          updatedAt: this.now().toISOString(),
        });
      },
    );
  }

  async clearActiveRun(
    canonicalThreadId: string,
    runId: string,
    terminalStatus?: T3ThreadBinding["status"],
  ): Promise<void> {
    await this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const binding = await this.bindings.get(canonicalThreadId);
        if (!binding || binding.activeRunId !== runId) return;
        const { activeRunId: _activeRunId, ...cleared } = binding;
        await this.bindings.bindRecord({
          ...cleared,
          status:
            terminalStatus ??
            (binding.status === "working" ? "error" : binding.status),
          updatedAt: this.now().toISOString(),
        });
      },
    );
  }

  /**
   * Rebuild a turn handle from its persisted dispatch so a relocated driver
   * can keep watching a turn it did not dispatch. The binding is re-read
   * because the worker may have changed sandbox generation since dispatch.
   */
  async resumeTurn(
    canonicalThreadId: string,
    dispatch: T3TurnDispatch,
  ): Promise<T3GatewayTurn | null> {
    const binding = await this.bindings.get(canonicalThreadId);
    if (!binding) return null;
    if (binding.t3ThreadId !== dispatch.threadId) {
      throw new Error(
        `Dispatch for T3 thread ${dispatch.threadId} does not match binding ${binding.t3ThreadId}`,
      );
    }
    return { binding, dispatch };
  }

  /**
   * Park a binding whose worker is confirmed gone without a restorable
   * checkpoint, so the next turn replaces the worker. No-ops when the
   * sandbox changed or a checkpoint exists (those recover through the
   * normal paths).
   */
  async markWorkerLost(
    canonicalThreadId: string,
    expectedSandboxId?: string,
  ): Promise<void> {
    await this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const binding = await this.bindings.get(canonicalThreadId);
        if (!binding || binding.workerSnapshotId) return;
        if (expectedSandboxId && binding.sandboxId !== expectedSandboxId) {
          return;
        }
        const lost: T3ThreadBinding = {
          ...binding,
          workerState: "suspended",
          warmUntil: undefined,
          status: "unavailable",
          updatedAt: this.now().toISOString(),
        };
        await this.bindings.bindRecord(lost);
        this.recordWorkerTransition("worker.lost", lost, { phase: "run" });
      },
    );
  }

  /** Called only during completion. Reconnect never provisions/restores a worker. */
  async captureWorkspaceReview(turn: T3GatewayTurn) {
    const environment = await this.environments.reconnect(turn.binding);
    if (!environment.sandbox || !environment.client.snapshot) throw new Error("Worker review capture is unavailable");
    const snapshot = await environment.client.waitForTurnTerminal({
      threadId: turn.binding.t3ThreadId,
      minimumSequence: turn.dispatch.sequence,
      messageId: turn.dispatch.messageId,
      requestedAt: turn.dispatch.createdAt,
      requireCheckpoint: true,
      timeoutMs: 60_000, absoluteTimeoutMs: 60_000,
    });
    const checkpoint = reviewCheckpointForMessage(snapshot, turn.dispatch.messageId);
    if (checkpoint?.status !== "ready") throw new Error("Worker checkpoint was not captured");
    const projects = await environment.client.snapshot();
    const cwd = typeof snapshot.thread.worktreePath === "string" ? snapshot.thread.worktreePath
      : projects.projects.find((project) => project.id === snapshot.thread.projectId)?.workspaceRoot;
    if (!cwd) throw new Error("Worker checkout is unavailable");
    const prefix = `refs/t3/checkpoints/${Buffer.from(turn.binding.t3ThreadId).toString("base64url")}/turn/`;
    return captureWorkspaceReview(environment.sandbox, {
      cwd, turnId: checkpoint.turnId, turnCount: checkpoint.checkpointTurnCount,
      toRef: checkpoint.checkpointRef, fromRef: `${prefix}${checkpoint.checkpointTurnCount - 1}`,
      initialRef: `${prefix}0`,
    });
  }

  async collectOutputArtifacts(
    turn: T3GatewayTurn,
    publish: (artifact: T3OutputArtifact) => Promise<void>,
  ): Promise<{
    published: Array<{ path: string; digest: string }>;
    failures: string[];
  }> {
    const environment = await this.environments.reconnect(turn.binding);
    if (!environment.sandbox) {
      return {
        published: [],
        failures: ["The T3 sandbox filesystem is unavailable."],
      };
    }
    return collectT3OutputArtifacts(environment.sandbox, publish);
  }
}

export function asT3CommandClient(client: T3Client): T3CommandClient {
  return client;
}
