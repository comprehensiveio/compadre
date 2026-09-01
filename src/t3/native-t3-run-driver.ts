import {
  isTerminalRunStatus,
  type StreamChunk as DurableStreamChunk,
  type TerminalRunStatus,
} from "@tanstack/ai";
import type { AgentRunDurability } from "../durability/runtime.js";
import { log, serializeError } from "../logging.js";
import { SlackRunMirror } from "../services/native-t3-slack-delivery.js";
import { dispatchWasSuperseded } from "../services/t3-slack-conversation.js";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import { InMemoryLockStore, type LockStore } from "./storage.js";
import {
  EventType,
  NATIVE_T3_PROTOCOL_VERSION,
  type StreamChunk,
} from "./agui-protocol.js";
import { NativeT3SnapshotProjector } from "./agui-stream.js";
import type {
  T3InputFile,
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "./client.js";
import { T3EnvironmentUnavailableError, type T3GatewayTurn } from "./gateway.js";
import {
  NativeT3RunRequestStore,
  type NativeT3RunRequest,
} from "./run-request-store.js";

export const DEFAULT_TERMINAL_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const CANCELLED_MESSAGE = "The native T3 run was cancelled.";
const RECONNECT_DELAY_MS = 15_000;
// A dead sandbox answers every reattach with "unavailable" instantly; after
// this many consecutive ones (~1 minute) the worker is confirmed gone.
const MAX_CONSECUTIVE_UNAVAILABLE = 4;
const WORKER_LOST_MESSAGE =
  "The thread's isolated worker ended before this turn completed (sandbox lifetime reached or the worker crashed). A follow-up message continues on a fresh worker from the saved context.";
const WORKER_LOST_CODE = "NATIVE_T3_WORKER_LOST";
const CANCELLED_CODE = "NATIVE_T3_RUN_CANCELLED";

/**
 * The gateway surface the durable driver depends on. T3Gateway satisfies it;
 * tests substitute deterministic fakes.
 */
export interface NativeT3DriverGateway {
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<T3InputFile>;
    blockedSlackDestination?: { channelId: string; threadTs: string };
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  resumeTurn(
    canonicalThreadId: string,
    dispatch: T3TurnDispatch,
  ): Promise<T3GatewayTurn | null>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<number | null>;
  snapshot?(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3GatewayTurn["binding"];
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null>;
  markActiveRun?(canonicalThreadId: string, runId: string): Promise<void>;
  markWorkerLost?(
    canonicalThreadId: string,
    expectedSandboxId?: string,
  ): Promise<void>;
  clearActiveRun?(
    canonicalThreadId: string,
    runId: string,
    terminalStatus?: T3ThreadBinding["status"],
  ): Promise<void>;
}

export interface NativeT3RunDriverDependencies {
  gateway: NativeT3DriverGateway;
  durability: AgentRunDurability;
  requests: NativeT3RunRequestStore;
  /**
   * Serializes driver-epoch claims with in-process drivers. Fresh attempts
   * claim `driverEpoch + 1` under the same lock key the coordinator uses, so
   * during a rollout overlap exactly one producer owns the run's log.
   */
  locks?: LockStore;
  /**
   * Collects /tmp/agent-outputs artifacts after the provider's final event
   * and returns their OUTPUT_ARTIFACT chunks. Wired by the activity layer so
   * the driver stays free of storage/Slack upload concerns.
   */
  collectArtifactEvents?(
    turn: T3GatewayTurn,
    request: NativeT3RunRequest,
  ): Promise<StreamChunk[]>;
  now?: () => number;
}

export interface DriveNativeT3RunOptions {
  /** Cancellation intent (Temporal activity cancellation or local abort). */
  signal?: AbortSignal;
  /** Progress callback mapped to Temporal activity heartbeats. */
  heartbeat?(detail: string): void;
  terminalWaitTimeoutMs?: number;
  /** Delay before reattaching after an interrupted watch (tests shrink it). */
  reconnectDelayMs?: number;
}

export interface NativeT3RunOutcome {
  status: TerminalRunStatus;
}

/**
 * A durable-state precondition failed (unknown run, missing request record,
 * vanished binding). Retrying cannot help; the activity layer maps this to a
 * non-retryable failure so the workflow finalizes immediately.
 */
export class NativeT3RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeT3RunStateError";
  }
}

function withProtocolVersion(chunk: StreamChunk): DurableStreamChunk {
  return {
    ...chunk,
    protocolVersion: NATIVE_T3_PROTOCOL_VERSION,
  } as unknown as DurableStreamChunk;
}

function cancelledChunk(runId: string, timestamp: number): StreamChunk {
  return {
    type: EventType.RUN_ERROR,
    runId,
    message: CANCELLED_MESSAGE,
    code: CANCELLED_CODE,
    timestamp,
  };
}

function terminalStatusFromChunks(
  chunks: readonly StreamChunk[],
  cancelRequested: boolean,
): TerminalRunStatus {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk?.type === EventType.RUN_FINISHED) return "completed";
    if (chunk?.type === EventType.RUN_ERROR) {
      return cancelRequested ? "aborted" : "failed";
    }
  }
  return cancelRequested ? "aborted" : "failed";
}

interface MirrorHandle {
  start(): Promise<void>;
  observe(chunk: StreamChunk): void;
  finish(): Promise<void>;
}

function buildMirror(
  request: NativeT3RunRequest,
  assistantTexts: ReadonlyMap<string, string>,
  shouldDeliverFinal?: () => Promise<boolean>,
): MirrorHandle | null {
  const mirror = request.slackMirror;
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!mirror || !botToken) return null;
  return new SlackRunMirror(
    {
      binding: {
        channelId: mirror.channelId,
        threadTs: mirror.threadTs,
        ...(mirror.recipientUserId
          ? { recipientUserId: mirror.recipientUserId }
          : {}),
        ...(mirror.recipientTeamId
          ? { recipientTeamId: mirror.recipientTeamId }
          : {}),
      },
      userMessage: mirror.userMessage,
      ...(mirror.detailsUrl ? { detailsUrl: mirror.detailsUrl } : {}),
      botToken,
      ...(shouldDeliverFinal ? { shouldDeliverFinal } : {}),
    },
    { assistantTexts },
  );
}

/**
 * Execute (or resume) one native T3 run against durable state alone.
 *
 * Restart-safety invariants:
 * - The worker turn is dispatched at most once: a durable dispatch record is
 *   written immediately after gateway.send, and any later attempt reattaches
 *   through resumeTurn instead of sending again.
 * - Projection resumes: the projector is rebuilt from the chunks already in
 *   the durable log, so a retried attempt appends only events the previous
 *   attempt had not persisted.
 * - Transient failures (worker reconnect, watch timeout, network) THROW so
 *   the orchestrator retries; only genuine provider terminals and explicit
 *   cancellation terminalize the run. This inverts the legacy stream, which
 *   turned every exception into a terminal RUN_ERROR.
 */
export async function driveNativeT3Run(
  deps: NativeT3RunDriverDependencies,
  runId: string,
  options: DriveNativeT3RunOptions = {},
): Promise<NativeT3RunOutcome> {
  const now = deps.now ?? Date.now;
  const heartbeat = options.heartbeat ?? (() => undefined);
  const runs = deps.durability.runs;

  const run = await runs.get(runId);
  if (!run) {
    throw new NativeT3RunStateError(`Unknown native T3 run ${runId}`);
  }
  if (isTerminalRunStatus(run.status)) {
    return { status: run.status };
  }

  const request = await deps.requests.getRequest(runId);
  if (!request) {
    throw new NativeT3RunStateError(
      `Native T3 run ${runId} has no persisted request`,
    );
  }

  // Claim the durable driver epoch BEFORE reading the persisted prefix: any
  // zombie producer (a retiring in-process driver, or a superseded earlier
  // attempt) loses append rights first, so the snapshot below is complete.
  const locks = deps.locks ?? new InMemoryLockStore();
  const epoch = await locks.withLock(
    `compadre:native-t3-run-driver:${runId}`,
    async () => {
      const current = await runs.get(runId);
      if (!current) {
        throw new NativeT3RunStateError(`Unknown native T3 run ${runId}`);
      }
      const next = (current.driverEpoch ?? 0) + 1;
      await runs.update(runId, { driverEpoch: next });
      return next;
    },
  );
  const owns = async () => (await runs.get(runId))?.driverEpoch === epoch;

  const stream = deps.durability.stream(runId);
  const persisted = (await stream.snapshot()).map(
    (entry) => entry.chunk as unknown as StreamChunk,
  );

  const append = async (chunk: StreamChunk) => {
    if (!(await owns())) {
      throw new Error(`Native T3 run ${runId} driver claim was superseded`);
    }
    await stream.append([withProtocolVersion(chunk)]);
  };

  const terminalize = async (
    status: TerminalRunStatus,
    error?: { message: string; code?: string },
  ): Promise<NativeT3RunOutcome> => {
    if (!(await owns())) {
      // A newer claim owns convergence; report the latest durable status.
      const latest = await runs.get(runId);
      console.warn("[native-t3-driver] terminalize skipped; claim superseded", {
        runId,
        status,
      });
      return {
        status:
          latest && isTerminalRunStatus(latest.status) ? latest.status : status,
      };
    }
    await runs.update(runId, {
      status,
      finishedAt: now(),
      ...(error ? { error } : {}),
    });
    await stream.close();
    await deps.gateway
      .clearActiveRun?.(
        request.canonicalThreadId,
        runId,
        status === "completed"
          ? "ready"
          : status === "aborted"
            ? "interrupted"
            : "error",
      )
      .catch((markerError) =>
        console.error("[native-t3-driver] active run marker not cleared", {
          runId,
          error: markerError,
        }),
      );
    await deps.requests.trimTerminalRequest(runId).catch(() => undefined);
    return { status };
  };

  // Cancellation that raced ahead of the driver: converge without dispatching.
  const dispatched = await deps.requests.getDispatch(runId);
  if (run.cancelRequested && !dispatched) {
    await append(cancelledChunk(runId, now()));
    return terminalize("aborted", {
      message: CANCELLED_MESSAGE,
      code: CANCELLED_CODE,
    });
  }
  if (options.signal?.aborted) {
    // The attempt was cancelled (timeout, retry supersession, worker drain)
    // without durable run-cancel intent. Hand off to the next attempt.
    throw new Error(`Native T3 run ${runId} drive attempt was cancelled before watching`);
  }

  let turn: T3GatewayTurn;
  if (dispatched) {
    const resumed = await deps.gateway.resumeTurn(
      request.canonicalThreadId,
      dispatched.dispatch,
    );
    if (!resumed) {
      throw new NativeT3RunStateError(
        `Native T3 run ${runId} lost its thread binding for ${request.canonicalThreadId}`,
      );
    }
    turn = resumed;
  } else {
    heartbeat("dispatching native T3 turn");
    turn = await deps.gateway.send({
      canonicalThreadId: request.canonicalThreadId,
      title: request.title,
      text: request.text,
      modelSelection: request.modelSelection,
      inputFiles: request.inputFiles,
      ...(request.blockedSlackDestination
        ? { blockedSlackDestination: request.blockedSlackDestination }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await deps.requests.saveDispatch(runId, {
      canonicalThreadId: request.canonicalThreadId,
      dispatch: turn.dispatch,
      dispatchedAt: new Date(now()).toISOString(),
    });
  }

  await deps.gateway
    .markActiveRun?.(request.canonicalThreadId, runId)
    .catch((error) =>
      console.error("[native-t3-driver] active run marker not written", {
        runId,
        error,
      }),
    );

  const projector = NativeT3SnapshotProjector.restore(
    runId,
    request.canonicalThreadId,
    turn.dispatch.messageId,
    persisted,
  );
  // A later steer of the same worker turn owns the shared Slack final answer.
  const shouldDeliverFinal = async (): Promise<boolean> => {
    if (!deps.gateway.snapshot) return true;
    try {
      const latest = await deps.gateway.snapshot({
        canonicalThreadId: request.canonicalThreadId,
        providerInstanceId: request.modelSelection.instanceId,
      });
      return latest
        ? !dispatchWasSuperseded(latest.snapshot, turn.dispatch)
        : true;
    } catch (error) {
      console.warn(
        "[native-t3-driver] could not determine final delivery owner",
        { runId, error },
      );
      return true;
    }
  };
  const mirror = buildMirror(request, projector.assistantTexts, shouldDeliverFinal);

  if (projector.isTerminal) {
    // A previous attempt persisted the terminal event but died before the
    // record converged. Finish delivery and the record; do not re-project.
    await mirror?.finish();
    const status = terminalStatusFromChunks(
      persisted,
      run.cancelRequested ?? false,
    );
    return terminalize(
      status,
      status === "completed"
        ? undefined
        : { message: "Native T3 run ended with a terminal error event." },
    );
  }

  if (mirror && persisted.length === 0) await mirror.start();

  const watchAbort = new AbortController();
  let cancelled = false;
  let handedOff = false;
  const onSignalAbort = () => {
    // A Temporal activity cancellation is ambiguous: it fires for genuine
    // run cancellation (workflow cancel after durable intent) but also for
    // attempt timeouts, retry supersession, and worker drain. Only durable
    // cancel intent may interrupt the billed worker turn; everything else
    // must leave the turn running for the next attempt to reattach.
    void (async () => {
      const current = await runs.get(runId).catch(() => null);
      if (current?.cancelRequested) {
        cancelled = true;
        await deps.gateway
          .cancel({
            canonicalThreadId: request.canonicalThreadId,
            providerInstanceId: turn.binding.providerInstanceId,
          })
          .catch((error) =>
            log.warn(
              {
                runId,
                canonicalThreadId: request.canonicalThreadId,
                sandboxId: turn.binding.sandboxId,
                ...serializeError(error),
              },
              "native t3 worker interrupt failed",
            ),
          );
        watchAbort.abort(CANCELLED_MESSAGE);
      } else {
        handedOff = true;
        log.info(
          { runId, canonicalThreadId: request.canonicalThreadId },
          "native t3 attempt handed off without run cancellation",
        );
        watchAbort.abort(
          `Native T3 run ${runId} drive attempt was cancelled without run intent`,
        );
      }
    })();
  };
  if (options.signal?.aborted) onSignalAbort();
  else options.signal?.addEventListener("abort", onSignalAbort, { once: true });

  try {
    const pending: StreamChunk[] = [];
    if (persisted.length === 0) {
      pending.push({
        type: EventType.RUN_STARTED,
        runId,
        threadId: request.canonicalThreadId,
        timestamp: now(),
      });
    }
    let terminalChunk: StreamChunk | undefined;
    let failure: unknown;
    let consecutiveUnavailable = 0;
    const inactivityLimitMs =
      options.terminalWaitTimeoutMs ?? DEFAULT_TERMINAL_WAIT_TIMEOUT_MS;
    let lastProgressAt = now();
    let lastSequence = -1;

    const drainChunk = async (chunk: StreamChunk) => {
      if (
        chunk.type === EventType.RUN_FINISHED &&
        request.collectArtifacts &&
        deps.collectArtifactEvents
      ) {
        const artifactEvents = await deps
          .collectArtifactEvents(turn, request)
          .catch((error) => {
            console.warn("[native-t3-driver] artifact collection failed", {
              runId,
              error,
            });
            return [] as StreamChunk[];
          });
        for (const artifactEvent of artifactEvents) {
          await append(artifactEvent);
          mirror?.observe(artifactEvent);
        }
      }
      await append(chunk);
      mirror?.observe(chunk);
      if (
        chunk.type === EventType.RUN_FINISHED ||
        chunk.type === EventType.RUN_ERROR
      ) {
        terminalChunk = chunk;
      }
    };

    // Supervision loop: one activity attempt rides out interrupted watches
    // (a CPU-starved sandbox stops answering snapshot reads while the turn
    // keeps working) by reattaching, and only fails the attempt when the
    // turn makes no durable progress for the full inactivity limit.
    for (;;) {
      let wake: (() => void) | undefined;
      let completed = false;
      let watchFailure: unknown;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const observeSnapshot = (snapshot: T3ThreadSnapshot) => {
        consecutiveUnavailable = 0;
        if (snapshot.snapshotSequence > lastSequence) {
          lastSequence = snapshot.snapshotSequence;
          lastProgressAt = now();
        }
        pending.push(...projector.project(snapshot));
      };
      const waiter = deps.gateway
        .waitForTerminal({
          turn,
          timeoutMs: inactivityLimitMs,
          signal: watchAbort.signal,
          onSnapshot(snapshot) {
            observeSnapshot(snapshot);
            heartbeat("streaming native T3 turn");
            notify();
          },
        })
        .then(
          (snapshot) => {
            observeSnapshot(snapshot);
            completed = true;
            notify();
          },
          (error) => {
            watchFailure = error;
            completed = true;
            notify();
          },
        );

      while (!completed || pending.length > 0) {
        if (pending.length === 0) {
          if (completed) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        await drainChunk(pending.shift()!);
      }
      await waiter;

      if (!watchFailure || terminalChunk) break;
      if (watchFailure instanceof NativeT3RunStateError) throw watchFailure;
      if (watchFailure instanceof T3EnvironmentUnavailableError) {
        consecutiveUnavailable += 1;
        if (
          consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE &&
          !turn.binding.workerSnapshotId
        ) {
          // The worker is confirmed dead with nothing to restore: retrying
          // (this attempt or the next) cannot revive the turn. Converge
          // promptly instead of burning the inactivity budget three times.
          log.error(
            {
              runId,
              canonicalThreadId: request.canonicalThreadId,
              sandboxId: turn.binding.sandboxId,
              generation: turn.binding.workerGeneration ?? 1,
              consecutiveUnavailable,
              code: WORKER_LOST_CODE,
              ...serializeError(watchFailure),
            },
            "native t3 worker lost; converging run as failed",
          );
          const lostChunk: StreamChunk = {
            type: EventType.RUN_ERROR,
            runId,
            message: WORKER_LOST_MESSAGE,
            code: WORKER_LOST_CODE,
            timestamp: now(),
          };
          await append(lostChunk);
          mirror?.observe(lostChunk);
          await mirror?.finish();
          await deps.gateway
            .markWorkerLost?.(request.canonicalThreadId, turn.binding.sandboxId)
            .catch((error) =>
              log.warn(
                {
                  runId,
                  canonicalThreadId: request.canonicalThreadId,
                  sandboxId: turn.binding.sandboxId,
                  ...serializeError(error),
                },
                "native t3 could not park lost worker",
              ),
            );
          return terminalize("failed", {
            message: WORKER_LOST_MESSAGE,
            code: WORKER_LOST_CODE,
          });
        }
      } else {
        consecutiveUnavailable = 0;
      }
      if (cancelled || handedOff) {
        // Either durable cancellation (converge below) or an attempt-level
        // cancellation without run intent (rethrown below for the next
        // attempt): never ride out an aborted attempt.
        failure = watchFailure;
        break;
      }
      if (now() - lastProgressAt >= inactivityLimitMs) {
        // A genuine stall: no durable progress across reattachments. Let the
        // orchestrator retry (and eventually finalize) this attempt.
        throw watchFailure;
      }
      log.warn(
        {
          runId,
          canonicalThreadId: request.canonicalThreadId,
          sandboxId: turn.binding.sandboxId,
          generation: turn.binding.workerGeneration ?? 1,
          consecutiveUnavailable,
          maxConsecutiveUnavailable: MAX_CONSECUTIVE_UNAVAILABLE,
          msSinceProgress: now() - lastProgressAt,
          inactivityLimitMs,
          reconnectDelayMs: options.reconnectDelayMs ?? RECONNECT_DELAY_MS,
          hasSnapshot: Boolean(turn.binding.workerSnapshotId),
          ...serializeError(watchFailure),
        },
        "native t3 watch interrupted; reattaching",
      );
      heartbeat("reattaching to native T3 turn");
      await new Promise<void>((resolve) => {
        // Deliberately ref'd: the reconnect pause is part of the activity's
        // legitimate lifetime and must not let an idle event loop exit.
        const timer = setTimeout(
          resolve,
          options.reconnectDelayMs ?? RECONNECT_DELAY_MS,
        );
        watchAbort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (cancelled) {
        failure = watchFailure;
        break;
      }
      const resumed = await deps.gateway
        .resumeTurn(request.canonicalThreadId, turn.dispatch)
        .catch(() => null);
      if (resumed) turn = resumed;
    }

    if (failure && !cancelled && !terminalChunk) {
      // Transient watch failure: leave the run open for the next attempt.
      throw failure;
    }

    if (cancelled && !terminalChunk) {
      await append(cancelledChunk(runId, now()));
      mirror?.observe(cancelledChunk(runId, now()));
      await mirror?.finish();
      return terminalize("aborted", {
        message: CANCELLED_MESSAGE,
        code: CANCELLED_CODE,
      });
    }

    if (!terminalChunk) {
      const message =
        "The native T3 turn ended without a terminal provider event.";
      await append({
        type: EventType.RUN_ERROR,
        runId,
        message,
        timestamp: now(),
      });
      await mirror?.finish();
      return terminalize("failed", { message });
    }

    await mirror?.finish();
    if (terminalChunk.type === EventType.RUN_FINISHED) {
      return terminalize("completed");
    }
    return terminalize(cancelled ? "aborted" : "failed", {
      message: terminalChunk.message ?? "Native T3 turn failed.",
      ...(cancelled ? { code: CANCELLED_CODE } : {}),
    });
  } finally {
    options.signal?.removeEventListener("abort", onSignalAbort);
  }
}

export interface FinalizeNativeT3RunOutcome {
  cancelled: boolean;
  message: string;
}

/**
 * Converge a run whose driver could not finish (exhausted retries, workflow
 * cancellation, non-retryable state error). Idempotent: an already-terminal
 * run only has its log close re-asserted and its worker lease released.
 */
export interface FinalizeNativeT3RunDependencies {
  durability: AgentRunDurability;
  requests: NativeT3RunRequestStore;
  gateway?: NativeT3DriverGateway;
  locks?: LockStore;
  now?: () => number;
}

export async function finalizeNativeT3Run(
  deps: FinalizeNativeT3RunDependencies,
  runId: string,
  outcome: FinalizeNativeT3RunOutcome,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const run = await deps.durability.runs.get(runId);
  const stream = deps.durability.stream(runId);
  if (run && !isTerminalRunStatus(run.status)) {
    // Claim a fresh driver epoch so any zombie producer loses append rights
    // before this convergence writes the terminal record.
    const locks = deps.locks ?? new InMemoryLockStore();
    await locks
      .withLock(`compadre:native-t3-run-driver:${runId}`, async () => {
        const current = await deps.durability.runs.get(runId);
        if (!current) return;
        await deps.durability.runs.update(runId, {
          driverEpoch: (current.driverEpoch ?? 0) + 1,
        });
      })
      .catch((error) =>
        console.warn("[native-t3-driver] finalize epoch claim failed", {
          runId,
          error,
        }),
      );
    const code = outcome.cancelled
      ? CANCELLED_CODE
      : "NATIVE_T3_WORKFLOW_FAILED";
    try {
      await stream.append([
        withProtocolVersion({
          type: EventType.RUN_ERROR,
          runId,
          message: outcome.message,
          code,
          timestamp: now(),
        }),
      ]);
    } catch (error) {
      console.warn("[native-t3-driver] could not append finalize event", {
        runId,
        error,
      });
    }
    try {
      await deps.durability.runs.update(runId, {
        status: outcome.cancelled ? "aborted" : "failed",
        finishedAt: now(),
        error: { message: outcome.message, code },
      });
    } finally {
      await stream.close();
    }
  } else {
    // A producer can die between updating the record and closing the log.
    await stream.close();
  }

  const request = await deps.requests.getRequest(runId).catch(() => null);
  if (request) {
    const markerStatus =
      run && isTerminalRunStatus(run.status)
        ? run.status === "completed"
          ? ("ready" as const)
          : run.status === "aborted"
            ? ("interrupted" as const)
            : ("error" as const)
        : outcome.cancelled
          ? ("interrupted" as const)
          : ("error" as const);
    await deps.gateway
      ?.clearActiveRun?.(request.canonicalThreadId, runId, markerStatus)
      .catch((error) =>
        console.error("[native-t3-driver] finalize marker not cleared", {
          runId,
          error,
        }),
      );
    await deps.requests.trimTerminalRequest(runId).catch(() => undefined);
  }
}
