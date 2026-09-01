import {
  EventType as CoreEventType,
  isTerminalRunStatus,
  type RunRecord,
  type StreamChunk as CoreStreamChunk,
} from "@tanstack/ai";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../temporal/client.js";
import {
  NATIVE_T3_TASK_QUEUE,
  nativeT3RunWorkflowId,
  type NativeT3RunWorkflowInput,
} from "../temporal/shared.js";
import { mirrorNativeT3RunToSlack } from "../services/native-t3-slack-delivery.js";
import { dispatchWasSuperseded } from "../services/t3-slack-conversation.js";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import {
  createNativeT3AguiRecoveryStream,
  createNativeT3AguiStream,
  traceNativeT3AguiStream,
  type NativeT3AguiGateway,
} from "./agui-stream.js";
import type { StreamChunk } from "./agui-protocol.js";
import type { DurableStreamOptions } from "../durability/runtime.js";
import type { T3GatewayTurn } from "./gateway.js";
import type {
  NativeT3RunCancelResult,
  NativeT3RunCoordinator,
  NativeT3RunStartResult,
} from "./run-coordinator.js";
import type { NativeT3DriverGateway } from "./native-t3-run-driver.js";
import {
  NativeT3RunRequestStore,
  type NativeT3RunRequest,
} from "./run-request-store.js";
import type { T3ThreadSnapshot } from "./client.js";

/**
 * The producer surface for native T3 runs. `startTurn` accepts a fully
 * serializable request so the Temporal implementation can hand execution to
 * any controller instance; reads and cancellation stay durability-backed.
 */
export interface NativeT3RunService {
  startTurn(request: NativeT3RunRequest): Promise<NativeT3RunStartResult>;
  stream(
    runId: string,
    options?: DurableStreamOptions,
  ): ReturnType<NativeT3RunCoordinator["stream"]>;
  run(runId: string): Promise<RunRecord | null>;
  activeRun(threadId: string): Promise<RunRecord | null>;
  cancel(runId: string): Promise<NativeT3RunCancelResult>;
  /**
   * Give a replay subscriber a producer when the run has none. The Temporal
   * implementation is a no-op — the workflow's retried drive activity is the
   * sole producer — while the in-process implementation reattaches the worker
   * turn exactly as startup recovery does.
   */
  ensureSubscriberRecovery(runId: string): Promise<void>;
}

export interface NativeT3WorkflowLauncher {
  start(options: {
    workflowId: string;
    input: NativeT3RunWorkflowInput;
  }): Promise<{ started: boolean }>;
  cancel(workflowId: string): Promise<boolean>;
}

export function createTemporalNativeT3WorkflowLauncher(
  getClient: () => Promise<{
    workflow: {
      start(
        workflowType: string,
        options: {
          taskQueue: string;
          workflowId: string;
          args: [NativeT3RunWorkflowInput];
        },
      ): Promise<unknown>;
      getHandle(workflowId: string): { cancel(): Promise<unknown> };
    };
  }> = getTemporalClient,
): NativeT3WorkflowLauncher {
  return {
    async start({ workflowId, input }) {
      const client = await getClient();
      try {
        await client.workflow.start("nativeT3RunWorkflow", {
          taskQueue: NATIVE_T3_TASK_QUEUE,
          workflowId,
          args: [input],
        });
        return { started: true };
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          return { started: false };
        }
        throw error;
      }
    },
    async cancel(workflowId) {
      const client = await getClient();
      try {
        await client.workflow.getHandle(workflowId).cancel();
        return true;
      } catch (error) {
        console.warn("[native-t3-run] workflow cancel dispatch failed", {
          workflowId,
          error: error instanceof Error ? error.name : typeof error,
        });
        return false;
      }
    },
  };
}

/**
 * Durable orchestration: the run request is persisted first, then a
 * deterministic workflow drives it. A controller restart moves the drive
 * activity to the surviving/replacement instance instead of orphaning the
 * run.
 */
export class TemporalNativeT3RunService implements NativeT3RunService {
  constructor(
    private readonly coordinator: NativeT3RunCoordinator,
    private readonly requests: NativeT3RunRequestStore,
    private readonly launcher: NativeT3WorkflowLauncher,
    private readonly now: () => number = Date.now,
  ) {}

  stream(runId: string, options?: DurableStreamOptions) {
    return this.coordinator.durability.stream(runId, options);
  }

  run(runId: string): Promise<RunRecord | null> {
    return this.coordinator.run(runId);
  }

  activeRun(threadId: string): Promise<RunRecord | null> {
    return this.coordinator.activeRun(threadId);
  }

  async startTurn(request: NativeT3RunRequest): Promise<NativeT3RunStartResult> {
    const durability = this.coordinator.durability;
    const existing = await durability.runs.get(request.runId);
    if (existing && existing.threadId !== request.canonicalThreadId) {
      throw new Error(
        `Native T3 run ${request.runId} belongs to thread ${existing.threadId}, not ${request.canonicalThreadId}`,
      );
    }
    if (existing && isTerminalRunStatus(existing.status)) {
      return { run: existing, started: false };
    }

    const run =
      existing ??
      (await durability.runs.createOrResume({
        runId: request.runId,
        threadId: request.canonicalThreadId,
        startedAt: this.now(),
      }));
    if (run.threadId !== request.canonicalThreadId) {
      throw new Error(
        `Native T3 run ${request.runId} was concurrently created for thread ${run.threadId}`,
      );
    }
    await this.requests.saveRequest(request);

    try {
      const launched = await this.launcher.start({
        workflowId: nativeT3RunWorkflowId(request.runId),
        input: { runId: request.runId, threadId: request.canonicalThreadId },
      });
      return { run, started: launched.started };
    } catch (error) {
      // Fail open: a run whose workflow never launched must not stay
      // "running" forever with silent subscribers.
      const finishedAt = this.now();
      const message = error instanceof Error ? error.message : String(error);
      const code = "NATIVE_T3_WORKFLOW_START_FAILED";
      const stream = durability.stream(request.runId);
      await stream
        .append([
          {
            type: CoreEventType.RUN_ERROR,
            message,
            code,
            timestamp: finishedAt,
          } as CoreStreamChunk,
        ])
        .catch(() => undefined);
      await durability.runs.update(request.runId, {
        status: "failed",
        finishedAt,
        error: { message, code },
      });
      await stream.close();
      throw error;
    }
  }

  async cancel(runId: string): Promise<NativeT3RunCancelResult> {
    // Durable intent plus the in-process fast path for any legacy run first.
    const result = await this.coordinator.cancel(runId);
    if (!result.found || !result.requested) return result;
    const dispatched = await this.launcher.cancel(nativeT3RunWorkflowId(runId));
    return { ...result, local: result.local || dispatched };
  }

  async ensureSubscriberRecovery(): Promise<void> {
    // Temporal owns production: the drive activity's retries already
    // reattach after controller loss, and a second in-process producer would
    // only trade driver-epoch claims with the activity.
  }
}

export interface InProcessNativeT3RunGateway extends NativeT3AguiGateway {
  cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<number | null>;
  markActiveRun?(canonicalThreadId: string, runId: string): Promise<void>;
  clearActiveRun?(
    canonicalThreadId: string,
    runId: string,
    terminalStatus?: T3ThreadBinding["status"],
  ): Promise<void>;
}

export interface InProcessNativeT3RunServiceDependencies {
  gateway: InProcessNativeT3RunGateway;
  coordinator: NativeT3RunCoordinator;
  collectArtifactEvents?(
    turn: T3GatewayTurn,
    request: NativeT3RunRequest,
  ): Promise<StreamChunk[]>;
}

/**
 * The pre-Temporal execution path, retained as the rollback for
 * NATIVE_T3_RUN_ORCHESTRATOR="in-process": the run is driven by a
 * fire-and-forget promise in this process and does not survive a restart.
 */
export class InProcessNativeT3RunService implements NativeT3RunService {
  private readonly activeTurns = new Map<string, T3GatewayTurn>();

  constructor(
    private readonly deps: InProcessNativeT3RunServiceDependencies,
  ) {}

  stream(runId: string, options?: DurableStreamOptions) {
    return this.deps.coordinator.durability.stream(runId, options);
  }

  run(runId: string): Promise<RunRecord | null> {
    return this.deps.coordinator.run(runId);
  }

  activeRun(threadId: string): Promise<RunRecord | null> {
    return this.deps.coordinator.activeRun(threadId);
  }

  async startTurn(request: NativeT3RunRequest): Promise<NativeT3RunStartResult> {
    const { gateway, coordinator, collectArtifactEvents } = this.deps;
    const botToken = process.env.SLACK_BOT_TOKEN?.trim();
    return coordinator.start({
      runId: request.runId,
      threadId: request.canonicalThreadId,
      source: (signal) => {
        let workerTurn: T3GatewayTurn | undefined;
        const nativeStream = createNativeT3AguiStream({
          gateway,
          canonicalThreadId: request.canonicalThreadId,
          runId: request.runId,
          title: request.title,
          text: request.text,
          modelSelection: request.modelSelection,
          inputFiles: request.inputFiles,
          ...(request.blockedSlackDestination
            ? { blockedSlackDestination: request.blockedSlackDestination }
            : {}),
          ...(request.collectArtifacts && collectArtifactEvents
            ? {
                outputArtifactEvents: (turn: T3GatewayTurn) =>
                  collectArtifactEvents(turn, request),
              }
            : {}),
          signal,
          onTurn: async (turn) => {
            workerTurn = turn;
            this.activeTurns.set(request.runId, turn);
            await gateway.markActiveRun?.(
              request.canonicalThreadId,
              request.runId,
            );
          },
          onTerminal: async () => {
            this.activeTurns.delete(request.runId);
            await gateway
              .clearActiveRun?.(request.canonicalThreadId, request.runId)
              .catch((error: unknown) => {
                console.error(
                  "[native-t3-run] active run marker could not be cleared",
                  {
                    runId: request.runId,
                    canonicalThreadId: request.canonicalThreadId,
                    error,
                  },
                );
              });
          },
        });
        const mirrored =
          request.slackMirror && botToken
            ? mirrorNativeT3RunToSlack(nativeStream, {
                binding: {
                  channelId: request.slackMirror.channelId,
                  threadTs: request.slackMirror.threadTs,
                  ...(request.slackMirror.recipientUserId
                    ? { recipientUserId: request.slackMirror.recipientUserId }
                    : {}),
                  ...(request.slackMirror.recipientTeamId
                    ? { recipientTeamId: request.slackMirror.recipientTeamId }
                    : {}),
                },
                userMessage: request.slackMirror.userMessage,
                ...(request.slackMirror.detailsUrl
                  ? { detailsUrl: request.slackMirror.detailsUrl }
                  : {}),
                botToken,
              })
            : nativeStream;
        return traceNativeT3AguiStream(mirrored, {
          canonicalThreadId: request.canonicalThreadId,
          runId: request.runId,
          provider: request.provider,
          model: request.modelSelection.model,
        });
      },
      cancel: async () => {
        const turn = this.activeTurns.get(request.runId);
        if (!turn) return;
        await gateway.cancel({
          canonicalThreadId: turn.binding.canonicalThreadId,
          providerInstanceId: turn.binding.providerInstanceId,
        });
      },
    });
  }

  cancel(runId: string): Promise<NativeT3RunCancelResult> {
    return this.deps.coordinator.cancel(runId);
  }

  /** Reattach a producer-less run for a replay subscriber (startup-recovery parity). */
  async ensureSubscriberRecovery(runId: string): Promise<void> {
    const { gateway, coordinator } = this.deps;
    const run = await coordinator.run(runId);
    if (!run) return;
    await coordinator.resume({
      runId,
      threadId: run.threadId,
      source: (signal) =>
        createNativeT3AguiRecoveryStream({
          gateway,
          canonicalThreadId: run.threadId,
          runId,
          startedAt: run.startedAt,
          signal,
          onTurn: async (turn) => {
            this.activeTurns.set(runId, turn);
            await gateway.markActiveRun?.(run.threadId, runId);
          },
          onTerminal: async () => {
            this.activeTurns.delete(runId);
            await gateway
              .clearActiveRun?.(run.threadId, runId)
              .catch((error: unknown) => {
                console.error(
                  "[native-t3-run] active run marker could not be cleared",
                  { runId, canonicalThreadId: run.threadId, error },
                );
              });
          },
        }),
      cancel: async () => {
        const active = this.activeTurns.get(runId);
        await gateway.cancel({
          canonicalThreadId: run.threadId,
          providerInstanceId: active?.binding.providerInstanceId ?? "",
        });
      },
    });
  }
}
