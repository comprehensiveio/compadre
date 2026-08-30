import {
  RUN_CANCEL_REASON,
  isTerminalRunStatus,
  requestRunCancel,
  type RunRecord,
  type StreamChunk as DurableStreamChunk,
} from "@tanstack/ai";
import { RunController } from "@tanstack/ai-sandbox";
import { InMemoryLockStore, type LockStore } from "@tanstack/ai/locks";
import type { AgentRunDurability } from "../durability/runtime.js";
import {
  NATIVE_T3_PROTOCOL_VERSION,
  type StreamChunk,
} from "./agui-protocol.js";

export interface NativeT3RunStart {
  runId: string;
  threadId: string;
  source(signal: AbortSignal): AsyncIterable<StreamChunk>;
  cancel(): Promise<void>;
}

export interface NativeT3RunStartResult {
  run: RunRecord;
  started: boolean;
}

export interface NativeT3RunCancelResult {
  found: boolean;
  requested: boolean;
  local: boolean;
  status?: RunRecord["status"];
}

interface ActiveNativeT3Run {
  abortController: AbortController;
  cancel(): Promise<void>;
  done: Promise<void>;
}

function protocolEvents(
  source: AsyncIterable<StreamChunk>,
): AsyncIterable<DurableStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        yield {
          ...event,
          protocolVersion: NATIVE_T3_PROTOCOL_VERSION,
        } as DurableStreamChunk;
      }
    },
  };
}

function mirrorAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

/**
 * Owns the durable lifecycle of native T3 provider runs.
 *
 * The interface deliberately separates the producer from subscribers:
 * `start` holds a distributed lock only while claiming a new run id, then
 * writes the provider stream to Postgres without retaining a scarce advisory-
 * lock connection for the lifetime of the run. HTTP readers independently
 * tail `stream`, so a subscriber disconnect cannot cancel billed work.
 * `cancel` records durable intent before using the in-process fast path.
 */
export class NativeT3RunCoordinator {
  private readonly active = new Map<string, ActiveNativeT3Run>();

  constructor(
    readonly durability: AgentRunDurability,
    private readonly locks: LockStore = new InMemoryLockStore(),
    private readonly now: () => number = Date.now,
  ) {}

  stream(runId: string) {
    return this.durability.stream(runId);
  }

  run(runId: string): Promise<RunRecord | null> {
    return this.durability.runs.get(runId);
  }

  activeRun(threadId: string): Promise<RunRecord | null> {
    return this.durability.runs.findActiveRun(threadId);
  }

  async start(input: NativeT3RunStart): Promise<NativeT3RunStartResult> {
    return this.locks.withLock(
      `compadre:native-t3-run-start:${input.runId}`,
      async (lockSignal) => {
        const existing = await this.durability.runs.get(input.runId);
        if (existing) {
          if (existing.threadId !== input.threadId) {
            throw new Error(
              `Native T3 run ${input.runId} belongs to thread ${existing.threadId}, not ${input.threadId}`,
            );
          }
          return { run: existing, started: false };
        }

        const run = await this.durability.runs.createOrResume({
          runId: input.runId,
          threadId: input.threadId,
          startedAt: this.now(),
        });
        if (run.threadId !== input.threadId) {
          throw new Error(
            `Native T3 run ${input.runId} was concurrently created for thread ${run.threadId}`,
          );
        }

        const abortController = new AbortController();
        const stopMirroring = mirrorAbort(lockSignal, abortController);
        const drive = (async () => {
          const current = await this.durability.runs.get(input.runId);
          if (!current || isTerminalRunStatus(current.status)) return;
          if (current.cancelRequested) {
            abortController.abort(RUN_CANCEL_REASON);
            await this.durability.runs.update(input.runId, {
              status: "aborted",
              finishedAt: this.now(),
            });
            await this.durability.stream(input.runId).close();
            return;
          }
          const controller = new RunController({
            runs: this.durability.runs,
            durability: (runId) => this.durability.stream(runId),
          });
          const handle = controller.start({
            runId: input.runId,
            threadId: input.threadId,
            stream: protocolEvents(input.source(abortController.signal)),
            signal: abortController.signal,
          });
          await handle.done;
        })();
        stopMirroring();
        const done = drive.then(
          () => undefined,
          async (error) => {
            console.error("[native-t3-run] producer failed", {
              runId: input.runId,
              error,
            });
            const current = await this.durability.runs.get(input.runId);
            if (current && !isTerminalRunStatus(current.status)) {
              await this.durability.runs.update(input.runId, {
                status: "failed",
                finishedAt: this.now(),
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  code: "NATIVE_T3_DRIVER_FAILED",
                },
              });
              await this.durability.stream(input.runId).close();
            }
          },
        ).finally(() => {
          if (this.active.get(input.runId)?.done === done) {
            this.active.delete(input.runId);
          }
        });
        this.active.set(input.runId, {
          abortController,
          cancel: input.cancel,
          done,
        });
        void done;
        return { run, started: true };
      },
    );
  }

  async cancel(runId: string): Promise<NativeT3RunCancelResult> {
    const run = await this.durability.runs.get(runId);
    if (!run) return { found: false, requested: false, local: false };
    if (isTerminalRunStatus(run.status)) {
      return {
        found: true,
        requested: false,
        local: false,
        status: run.status,
      };
    }

    await requestRunCancel(this.durability.runs, runId);
    const active = this.active.get(runId);
    if (active) {
      try {
        await active.cancel();
      } finally {
        active.abortController.abort(RUN_CANCEL_REASON);
      }
    }
    return {
      found: true,
      requested: true,
      local: active !== undefined,
      status: run.status,
    };
  }
}
