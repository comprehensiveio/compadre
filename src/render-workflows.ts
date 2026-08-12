import {
  TaskRunStatus,
  type TaskRunDetails,
} from "@renderinc/sdk/workflows";

const TERMINAL_STATUSES = new Set<TaskRunDetails["status"]>([
  TaskRunStatus.COMPLETED,
  TaskRunStatus.SUCCEEDED,
  TaskRunStatus.FAILED,
  TaskRunStatus.CANCELED,
]);

export function isTaskRunSuccessful(status: TaskRunDetails["status"]): boolean {
  return (
    status === TaskRunStatus.COMPLETED || status === TaskRunStatus.SUCCEEDED
  );
}

export interface TaskRunReader {
  getTaskRun(taskRunId: string): Promise<TaskRunDetails>;
}

export interface WaitForTaskRunOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  maxConsecutiveReadErrors?: number;
}

function defaultSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Task run wait aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Task run wait aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Poll because the SDK's one-shot event stream can miss a terminal event. */
export async function waitForTaskRun(
  reader: TaskRunReader,
  taskRunId: string,
  options: WaitForTaskRunOptions = {},
): Promise<TaskRunDetails> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const maxConsecutiveReadErrors = options.maxConsecutiveReadErrors ?? 5;
  let consecutiveReadErrors = 0;
  let lastStatus: TaskRunDetails["status"] | undefined;

  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Task run wait aborted");
    }
    let run: TaskRunDetails | undefined;
    try {
      run = await reader.getTaskRun(taskRunId);
      consecutiveReadErrors = 0;
      lastStatus = run.status;
    } catch (error) {
      consecutiveReadErrors += 1;
      if (consecutiveReadErrors > maxConsecutiveReadErrors) throw error;
    }
    if (run && TERMINAL_STATUSES.has(run.status)) return run;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Timed out waiting for Workflow task ${taskRunId} after ${elapsedMs}ms (last status: ${lastStatus ?? "unknown"})`,
      );
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs), options.signal);
  }
}
