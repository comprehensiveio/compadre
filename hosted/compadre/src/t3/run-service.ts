import {
  EventType as CoreEventType,
  isTerminalRunStatus,
  type RunRecord,
  type StreamChunk as CoreStreamChunk,
} from "@tanstack/ai";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
} from "@temporalio/client";
import { getTemporalClient } from "../temporal/client.js";
import { InMemoryLockStore, type LockStore } from "./storage.js";
import {
  NATIVE_T3_TASK_QUEUE,
  nativeT3RunWorkflowId,
  type NativeT3RunWorkflowInput,
} from "../temporal/shared.js";
import type { DurableStreamOptions } from "../durability/runtime.js";
import type {
  NativeT3RunCancelResult,
  NativeT3RunCoordinator,
  NativeT3RunStartResult,
} from "./run-coordinator.js";
import {
  NativeT3RunRequestStore,
  type NativeT3RunRequest,
} from "./run-request-store.js";
import type { NativeT3SteeringInput } from "./run-control.js";

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
  steer(runId: string, input: NativeT3SteeringInput): Promise<boolean>;

}

export interface NativeT3WorkflowLauncher {
  start(options: {
    workflowId: string;
    input: NativeT3RunWorkflowInput;
  }): Promise<{ started: boolean }>;
  cancel(workflowId: string): Promise<boolean>;
  steer(workflowId: string, input: NativeT3SteeringInput): Promise<boolean>;
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
      getHandle(workflowId: string): {
        cancel(): Promise<unknown>;
        result?(): Promise<unknown>;
        executeUpdate?<T>(
          name: string,
          options: { args: [NativeT3SteeringInput]; updateId: string },
        ): Promise<T>;
      };
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
    async steer(workflowId, input) {
      const client = await getClient();
      const handle = client.workflow.getHandle(workflowId);
      if (!handle.executeUpdate) return false;
      return handle.executeUpdate<boolean>("steerNativeT3Run", {
        args: [input],
        updateId: input.id,
      });
    },
    async cancel(workflowId) {
      const client = await getClient();
      try {
        const handle = client.workflow.getHandle(workflowId);
        await handle.cancel();
        // T3 must not advertise the session as ready until provider cleanup,
        // interrupted snapshot persistence, and workspace checkpointing end.
        await handle.result?.().catch((error: unknown) => {
          if (!(error instanceof WorkflowFailedError)) throw error;
        });
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
    private readonly locks: LockStore = new InMemoryLockStore(),
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
    return this.locks.withLock(`compadre:native-t3-run-start:${request.runId}`, () => this.startTurnLocked(request));
  }

  private async startTurnLocked(request: NativeT3RunRequest): Promise<NativeT3RunStartResult> {
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

    // Persist all inputs before advertising a running execution. Failed uploads
    // or database writes must not leave a run with no recoverable request.
    if (!existing) await this.requests.saveRequest(request);
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
    // Record durable cancellation intent before cancelling the workflow.
    const result = await this.coordinator.cancel(runId);
    if (!result.found || !result.requested) return result;
    const dispatched = await this.launcher.cancel(nativeT3RunWorkflowId(runId));
    return { ...result, local: result.local || dispatched };
  }

  async steer(
    runId: string,
    input: NativeT3SteeringInput,
  ): Promise<boolean> {
    if ((await this.requests.getRequest(runId))?.providerAction) return false;
    const run = await this.run(runId);
    if (!run || isTerminalRunStatus(run.status) || run.cancelRequested) {
      return false;
    }
    return this.launcher.steer(nativeT3RunWorkflowId(runId), input);
  }

}
