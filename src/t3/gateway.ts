import { randomUUID } from "node:crypto";
import { metrics } from "@opentelemetry/api";
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

export interface T3CommandClient {
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
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    signal?: AbortSignal;
  }): Promise<T3TurnDispatch>;
  interruptTurn(input: {
    threadId: string;
    turnId?: string;
    signal?: AbortSignal;
  }): Promise<number>;
  waitForTurnTerminal(input: {
    threadId: string;
    minimumSequence: number;
    messageId?: string;
    requestedAt?: string;
    timeoutMs?: number;
    absoluteTimeoutMs?: number;
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
  hibernate?(
    binding: T3ThreadBinding,
    connection?: T3EnvironmentConnection,
  ): Promise<{ snapshotId: string }>;
  discard?(connection: T3EnvironmentConnection): Promise<void>;
}

export class T3EnvironmentUnavailableError extends Error {
  constructor(readonly sandboxId: string) {
    super(`T3 Modal sandbox ${sandboxId} is unavailable`);
    this.name = "T3EnvironmentUnavailableError";
  }
}

export interface T3WorkerLifecycleOptions {
  warmLeaseMs?: number;
  maxLiveMs?: number;
  hibernationSafetyMs?: number;
  schedule?(task: () => void, delayMs: number): void;
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
const DEFAULT_WORKER_WARM_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_WORKER_MAX_LIVE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_HIBERNATION_SAFETY_MS = 5 * 60 * 1000;
const HIBERNATION_RETRY_MS = 60 * 1000;
const STALE_HIBERNATION_MS = 10 * 60 * 1000;
const HIBERNATION_SWEEP_CONCURRENCY = 4;
const workerLifecycleTransitions = metrics
  .getMeter("compadre.runtime")
  .createCounter("compadre.t3.worker.lifecycle.transitions", {
    description: "Native T3 worker lifecycle transitions",
  });
const workerLiveDuration = metrics
  .getMeter("compadre.runtime")
  .createHistogram("compadre.t3.worker.live.duration", {
    unit: "ms",
    description: "Elapsed live time before a native T3 worker is hibernated",
  });

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
  private readonly warmLeaseMs: number;
  private readonly maxLiveMs: number;
  private readonly hibernationSafetyMs: number;
  private readonly schedule: (task: () => void, delayMs: number) => void;

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
  ) {
    this.warmLeaseMs =
      workerLifecycle.warmLeaseMs ?? DEFAULT_WORKER_WARM_LEASE_MS;
    this.maxLiveMs = workerLifecycle.maxLiveMs ?? DEFAULT_WORKER_MAX_LIVE_MS;
    this.hibernationSafetyMs =
      workerLifecycle.hibernationSafetyMs ?? DEFAULT_HIBERNATION_SAFETY_MS;
    if (!Number.isFinite(this.warmLeaseMs) || this.warmLeaseMs <= 0) {
      throw new Error("T3 worker warm lease must be a positive number");
    }
    if (!Number.isFinite(this.maxLiveMs) || this.maxLiveMs <= 0) {
      throw new Error("T3 worker maximum live time must be a positive number");
    }
    if (
      !Number.isFinite(this.hibernationSafetyMs) ||
      this.hibernationSafetyMs < 0 ||
      this.hibernationSafetyMs >= this.maxLiveMs
    ) {
      throw new Error(
        "T3 worker hibernation safety margin must be non-negative and below the maximum live time",
      );
    }
    this.schedule =
      workerLifecycle.schedule ??
      ((task, delayMs) => {
        const timer = setTimeout(task, delayMs);
        timer.unref();
      });
  }

  private lockKey(canonicalThreadId: string) {
    return `compadre:t3-environment:${canonicalThreadId}`;
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
    console.log("[t3-worker-lifecycle]", {
      event,
      canonicalThreadId: binding.canonicalThreadId,
      sandboxId: binding.sandboxId,
      provider: binding.providerInstanceId,
      generation: binding.workerGeneration ?? 1,
      ...attributes,
    });
  }

  private scheduleHibernation(binding: T3ThreadBinding): void {
    if (!this.environments.hibernate || !binding.warmUntil) return;
    const delayMs = Math.max(
      0,
      Date.parse(binding.warmUntil) - this.now().getTime(),
    );
    this.schedule(() => {
      void this.hibernateIfWarm(binding.canonicalThreadId).catch((error) => {
        console.error("[t3-worker-lifecycle] hibernation failed", {
          canonicalThreadId: binding.canonicalThreadId,
          sandboxId: binding.sandboxId,
          generation: binding.workerGeneration ?? 1,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
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
        if (binding.workerState === "hibernating") {
          if (!this.environments.hibernate) throw error;
          const checkpoint = await this.environments.hibernate(binding);
          const timestamp = this.now().toISOString();
          binding = {
            ...binding,
            workerState: "suspended",
            workerSnapshotId: checkpoint.snapshotId,
            warmUntil: undefined,
            lastActiveAt: timestamp,
            updatedAt: timestamp,
          };
          await this.bindings.bindRecord(binding);
          this.recordWorkerTransition("hibernate.completed", binding, {
            snapshotId: checkpoint.snapshotId,
            recoveredForTurn: true,
          });
        }
      }
    }
    if (!binding.workerSnapshotId || !this.environments.restore) {
      throw new T3EnvironmentUnavailableError(binding.sandboxId);
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

  private async hibernateIfWarm(canonicalThreadId: string): Promise<void> {
    if (!this.environments.hibernate) return;
    await this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const binding = await this.bindings.get(canonicalThreadId);
        const nowMs = this.now().getTime();
        const updatedAtMs = binding
          ? Date.parse(binding.updatedAt)
          : Number.NaN;
        const expiredWarm =
          binding?.workerState === "warm" &&
          Boolean(binding.warmUntil) &&
          Date.parse(binding.warmUntil!) <= nowMs;
        const staleHibernation =
          binding?.workerState === "hibernating" &&
          Number.isFinite(updatedAtMs) &&
          updatedAtMs <= nowMs - STALE_HIBERNATION_MS;
        if (!binding || (!expiredWarm && !staleHibernation)) {
          return;
        }

        const hibernating: T3ThreadBinding = {
          ...binding,
          workerState: "hibernating",
          updatedAt: this.now().toISOString(),
        };
        await this.bindings.bindRecord(hibernating);
        this.recordWorkerTransition(
          staleHibernation ? "hibernate.recovered" : "hibernate.started",
          hibernating,
        );
        try {
          const environment = staleHibernation
            ? undefined
            : await this.environments.reconnect(hibernating);
          const checkpoint = await this.environments.hibernate!(
            hibernating,
            environment,
          );
          const timestamp = this.now().toISOString();
          const suspended: T3ThreadBinding = {
            ...hibernating,
            workerState: "suspended",
            workerSnapshotId: checkpoint.snapshotId,
            warmUntil: undefined,
            lastActiveAt: timestamp,
            updatedAt: timestamp,
          };
          await this.bindings.bindRecord(suspended);
          const startedAt = Date.parse(
            suspended.sandboxStartedAt ?? suspended.createdAt,
          );
          if (Number.isFinite(startedAt)) {
            workerLiveDuration.record(
              Math.max(0, this.now().getTime() - startedAt),
              {
                provider: suspended.providerInstanceId,
                generation: suspended.workerGeneration ?? 1,
              },
            );
          }
          this.recordWorkerTransition("hibernate.completed", suspended, {
            snapshotId: checkpoint.snapshotId,
          });
        } catch (error) {
          if (
            error instanceof T3EnvironmentUnavailableError &&
            !binding.workerSnapshotId
          ) {
            // Nothing to snapshot and nothing to restore: the worker is
            // gone for good (sandbox lifetime or crash before the first
            // hibernation). Park the binding instead of retrying forever;
            // the next turn replaces the worker.
            const lost: T3ThreadBinding = {
              ...binding,
              workerState: "suspended",
              warmUntil: undefined,
              status: "unavailable",
              updatedAt: this.now().toISOString(),
            };
            await this.bindings.bindRecord(lost).catch(() => undefined);
            this.recordWorkerTransition("worker.lost", lost, {
              phase: "hibernate",
            });
            return;
          }
          const retry: T3ThreadBinding = {
            ...binding,
            workerState: "warm",
            warmUntil: new Date(
              this.now().getTime() + HIBERNATION_RETRY_MS,
            ).toISOString(),
            updatedAt: this.now().toISOString(),
          };
          await this.bindings.bindRecord(retry).catch(() => undefined);
          this.scheduleHibernation(retry);
          this.recordWorkerTransition("hibernate.failed", retry, {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        }
      },
    );
  }

  async sweepExpiredWarmWorkers(): Promise<void> {
    const nowMs = this.now().getTime();
    const candidates = (await this.bindings.list()).filter((binding) => {
      if (binding.workerState === "warm" && binding.warmUntil) {
        return Date.parse(binding.warmUntil) <= nowMs;
      }
      return (
        binding.workerState === "hibernating" &&
        Date.parse(binding.updatedAt) <= nowMs - STALE_HIBERNATION_MS
      );
    });
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < candidates.length) {
        const binding = candidates[nextIndex++];
        if (!binding) return;
        await this.hibernateIfWarm(binding.canonicalThreadId).catch(
          () => undefined,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(HIBERNATION_SWEEP_CONCURRENCY, candidates.length) },
        worker,
      ),
    );
  }

  /**
   * Rebuilds lost in-process timers after a controller restart and bounds how
   * long an overdue warm worker can continue accruing compute charges.
   */
  startWorkerLifecycleSweeper(intervalMs = 60_000): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("T3 worker sweep interval must be a positive number");
    }
    let inFlight: Promise<void> | undefined;
    let stopped = false;
    const sweep = () => {
      if (stopped || inFlight) return;
      inFlight = this.sweepExpiredWarmWorkers()
        .catch((error) => {
          console.error("[t3-worker-lifecycle] sweep failed", {
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          inFlight = undefined;
        });
    };
    sweep();
    const timer = setInterval(sweep, intervalMs);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
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
        const remainingMs = Math.max(
          1,
          deadline - this.now().getTime(),
        );
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
          (lateEnvironment) =>
            this.environments.discard!(lateEnvironment),
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
        const waitRemainingMs = Math.max(
          1,
          deadline - this.now().getTime(),
        );
        const snapshot = await environment.client.waitForTurnTerminal({
          threadId,
          minimumSequence: dispatch.sequence,
          messageId: dispatch.messageId,
          requestedAt: dispatch.createdAt,
          timeoutMs: waitRemainingMs,
          signal: attemptSignal,
        });
        const state = snapshot.thread.latestTurn?.state;
        const startFailure = preTurnStartFailure(
          snapshot,
          dispatch.messageId,
        );
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
        // The worker died without a restorable snapshot (sandbox lifetime
        // reached mid-turn, or a crash before the first hibernation). The
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
      const dispatch = await environment.client.startNewThread({
        threadId: t3ThreadId,
        projectId: environment.projectId,
        title: input.title,
        text: input.text,
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

  /**
   * Resolves the existing thread sandbox's development server without ever
   * provisioning a replacement environment. The returned Modal URL is an
   * internal routing detail and must only be exposed to the authenticated
   * preview gateway.
   */
  async previewTarget(input: {
    canonicalThreadId: string;
  }): Promise<T3PreviewTarget | null> {
    const binding = await this.bindings.get(input.canonicalThreadId);
    if (!binding) return null;
    const environment = await this.environments.reconnect(binding);
    if (!environment.sandbox) {
      throw new Error(
        `T3 Modal sandbox ${binding.sandboxId} does not expose a development server`,
      );
    }
    const channel = await environment.sandbox.ports.connect(3000);
    return { binding, url: channel.url };
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
          workerStartedAt + this.maxLiveMs - this.hibernationSafetyMs -
            this.now().getTime(),
        )
      : this.maxLiveMs - this.hibernationSafetyMs;
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
    const desiredWarmUntil = this.now().getTime() + this.warmLeaseMs;
    const sandboxStartedAt = Date.parse(
      input.turn.binding.sandboxStartedAt ?? input.turn.binding.createdAt,
    );
    const latestSafeWarmUntil = Number.isFinite(sandboxStartedAt)
      ? sandboxStartedAt + this.maxLiveMs - this.hibernationSafetyMs
      : desiredWarmUntil;
    // The turn was dispatched before its durable activeRunId marker was
    // written. Merge terminal state onto the latest binding so this waiter
    // cannot erase a newer marker with its stale pre-dispatch copy.
    const currentBinding =
      await this.bindings.get(input.turn.binding.canonicalThreadId) ??
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
      ...(this.environments.hibernate
        ? {
            workerState: "warm" as const,
            lastActiveAt: timestamp,
            warmUntil: new Date(
              Math.min(desiredWarmUntil, latestSafeWarmUntil),
            ).toISOString(),
          }
        : {}),
      updatedAt: timestamp,
    };
    await this.bindings.bind(updated);
    this.scheduleHibernation(updated);
    if (updated.workerState === "warm") {
      this.recordWorkerTransition("warm.started", updated, {
        warmUntil: updated.warmUntil,
      });
    }
    return snapshot;
  }

  async markActiveRun(canonicalThreadId: string, runId: string): Promise<void> {
    await this.locks.withLock(this.lockKey(canonicalThreadId), async (signal) => {
      if (signal.aborted) throw signal.reason;
      const binding = await this.bindings.get(canonicalThreadId);
      if (!binding) throw new Error(`T3 thread ${canonicalThreadId} is not bound`);
      await this.bindings.bindRecord({
        ...binding,
        activeRunId: runId,
        status: "working",
        updatedAt: this.now().toISOString(),
      });
    });
  }

  async clearActiveRun(
    canonicalThreadId: string,
    runId: string,
    terminalStatus?: T3ThreadBinding["status"],
  ): Promise<void> {
    await this.locks.withLock(this.lockKey(canonicalThreadId), async (signal) => {
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
    });
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
   * snapshot, so the sweeper stops retrying hibernation and the next turn
   * replaces the worker. No-ops when the sandbox changed or a snapshot
   * exists (those recover through the normal paths).
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

  /**
   * Converge a worker left "running" after its run terminalized without a
   * successful waitForTerminal (driver crash, watch timeout, cancellation).
   * Without this the binding matches neither sweep predicate and the sandbox
   * burns until Modal's hard timeout.
   */
  async releaseWorkerAfterRun(
    canonicalThreadId: string,
    releasingRunId?: string,
  ): Promise<void> {
    if (!this.environments.hibernate) return;
    await this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const binding = await this.bindings.get(canonicalThreadId);
        if (!binding || binding.workerState !== "running") return;
        if (
          binding.activeRunId &&
          releasingRunId &&
          binding.activeRunId !== releasingRunId
        ) {
          // Another run still owns this worker (a failed steer must not warm
          // the container out from under the original turn, 2026-09-01).
          return;
        }
        const timestamp = this.now().toISOString();
        const desiredWarmUntil = this.now().getTime() + this.warmLeaseMs;
        const sandboxStartedAt = Date.parse(
          binding.sandboxStartedAt ?? binding.createdAt,
        );
        const latestSafeWarmUntil = Number.isFinite(sandboxStartedAt)
          ? sandboxStartedAt + this.maxLiveMs - this.hibernationSafetyMs
          : desiredWarmUntil;
        const updated: T3ThreadBinding = {
          ...binding,
          workerState: "warm",
          lastActiveAt: timestamp,
          warmUntil: new Date(
            Math.min(desiredWarmUntil, latestSafeWarmUntil),
          ).toISOString(),
          updatedAt: timestamp,
        };
        await this.bindings.bindRecord(updated);
        this.scheduleHibernation(updated);
        this.recordWorkerTransition("warm.recovered", updated, {
          warmUntil: updated.warmUntil,
        });
      },
    );
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
