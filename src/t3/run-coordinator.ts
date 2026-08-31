import {
  RUN_CANCEL_REASON,
  isTerminalRunStatus,
  requestRunCancel,
  type RunStore,
  type RunRecord,
  type StreamChunk as DurableStreamChunk,
  type StreamDurability,
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
  /** Marks a run for deterministic startup reconciliation after host loss. */
  recoveryKey?: string;
  source(signal: AbortSignal): AsyncIterable<StreamChunk>;
  cancel(): Promise<void>;
}

export interface NativeT3RunStartResult {
  run: RunRecord;
  started: boolean;
}

export interface NativeT3RunResumeResult {
  run: RunRecord;
  resumed: boolean;
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
        if (input.recoveryKey) {
          await this.durability.runs.update(input.runId, {
            sandboxKey: input.recoveryKey,
            detachedSince: this.now(),
          });
        }

        this.beginDrive(input, lockSignal);
        return { run, started: true };
      },
    );
  }

  /**
   * Reattach a durable run whose original controller process disappeared.
   * The source must attach to the existing worker turn rather than dispatch a
   * second provider request. A monotonically increasing epoch fences every
   * event-log and terminal-record write from an older controller.
   */
  async resume(input: NativeT3RunStart): Promise<NativeT3RunResumeResult> {
    return this.locks.withLock(
      `compadre:native-t3-run-resume:${input.runId}`,
      async (lockSignal) => {
        const run = await this.durability.runs.get(input.runId);
        if (!run) throw new Error(`Cannot resume unknown native T3 run ${input.runId}`);
        if (run.threadId !== input.threadId) {
          throw new Error(
            `Native T3 run ${input.runId} belongs to thread ${run.threadId}, not ${input.threadId}`,
          );
        }
        if (isTerminalRunStatus(run.status) || this.active.has(input.runId)) {
          return { run, resumed: false };
        }
        this.beginDrive(input, lockSignal);
        return { run, resumed: true };
      },
    );
  }

  /** Return non-terminal runs explicitly marked for this recovery owner. */
  async recoverableRuns(recoveryKey: string): Promise<RunRecord[]> {
    const listReclaimable = this.durability.runs.listReclaimable;
    if (!listReclaimable) return [];
    const runs = await listReclaimable.call(this.durability.runs, {
      now: this.now(),
      ttlMs: 0,
    });
    return runs.filter((run) => run.sandboxKey === recoveryKey);
  }

  private beginDrive(input: NativeT3RunStart, claimSignal: AbortSignal): void {
    const abortController = new AbortController();
    const stopMirroring = mirrorAbort(claimSignal, abortController);
    let epoch = 0;
    const drive = (async () => {
      epoch = await this.claim(input.runId);
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
        runs: this.fencedRuns(epoch),
        durability: (runId) => this.fencedStream(runId, epoch),
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
        if (
          current &&
          !isTerminalRunStatus(current.status) &&
          current.driverEpoch === epoch
        ) {
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
  }

  private async claim(runId: string): Promise<number> {
    return this.locks.withLock(
      `compadre:native-t3-run-driver:${runId}`,
      async () => {
        const current = await this.durability.runs.get(runId);
        if (!current) throw new Error(`Cannot claim unknown native T3 run ${runId}`);
        const epoch = (current.driverEpoch ?? 0) + 1;
        await this.durability.runs.update(runId, { driverEpoch: epoch });
        return epoch;
      },
    );
  }

  private async owns(runId: string, epoch: number): Promise<boolean> {
    return (await this.durability.runs.get(runId))?.driverEpoch === epoch;
  }

  private fencedRuns(epoch: number): RunStore {
    const underlying = this.durability.runs;
    return new Proxy(underlying, {
      get: (target, property, receiver) => {
        if (property === "update") {
          return async (runId: string, patch: Parameters<RunStore["update"]>[1]) => {
            if (!(await this.owns(runId, epoch))) return;
            await underlying.update(runId, patch);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private fencedStream(runId: string, epoch: number): StreamDurability<string> {
    const underlying = this.durability.stream(runId);
    return {
      resumeFrom: () => underlying.resumeFrom(),
      read: (offset, signal) => underlying.read(offset, signal),
      snapshot: () => underlying.snapshot(),
      append: async (chunks) => {
        if (!(await this.owns(runId, epoch))) {
          throw new Error(`Native T3 run ${runId} driver claim was superseded`);
        }
        return underlying.append(chunks);
      },
      close: async () => {
        if (await this.owns(runId, epoch)) await underlying.close();
      },
    };
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
