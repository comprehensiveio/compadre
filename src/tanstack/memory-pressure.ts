import { readFile } from "node:fs/promises";

const CGROUP_V2_USAGE = "/sys/fs/cgroup/memory.current";
const CGROUP_V2_LIMIT = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_USAGE = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const CGROUP_V1_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
const DEFAULT_ABORT_RATIO = 0.95;
const DEFAULT_INTERVAL_MS = 2_000;

export interface MemoryUsage {
  usageBytes: number;
  limitBytes: number;
}

function parseBytes(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function readMemoryPair(
  usagePath: string,
  limitPath: string,
): Promise<MemoryUsage | undefined> {
  try {
    const [usageValue, limitValue] = await Promise.all([
      readFile(usagePath, "utf8"),
      readFile(limitPath, "utf8"),
    ]);
    const usageBytes = parseBytes(usageValue);
    const limitBytes = parseBytes(limitValue);
    return usageBytes && limitBytes ? { usageBytes, limitBytes } : undefined;
  } catch {
    return undefined;
  }
}

export async function readCgroupMemoryUsage(): Promise<
  MemoryUsage | undefined
> {
  return (
    (await readMemoryPair(CGROUP_V2_USAGE, CGROUP_V2_LIMIT)) ??
    (await readMemoryPair(CGROUP_V1_USAGE, CGROUP_V1_LIMIT))
  );
}

export function memoryPressureExceeded(
  memory: MemoryUsage,
  abortRatio: number,
): boolean {
  return memory.usageBytes / memory.limitBytes >= abortRatio;
}

function configuredAbortRatio(): number {
  const value = Number(process.env.COMPADRE_MEMORY_ABORT_RATIO);
  return Number.isFinite(value) && value >= 0.5 && value < 1
    ? value
    : DEFAULT_ABORT_RATIO;
}

export function startMemoryPressureWatchdog(
  abortController: AbortController,
  options: {
    intervalMs?: number;
    abortRatio?: number;
    readMemory?: () => Promise<MemoryUsage | undefined>;
    logger?: Pick<Console, "error">;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const abortRatio = options.abortRatio ?? configuredAbortRatio();
  const readMemory = options.readMemory ?? readCgroupMemoryUsage;
  const logger = options.logger ?? console;
  let reading = false;

  const timer = setInterval(() => {
    if (reading || abortController.signal.aborted) return;
    reading = true;
    void readMemory()
      .then((memory) => {
        if (!memory || !memoryPressureExceeded(memory, abortRatio)) return;
        const percentage = Math.round(
          (memory.usageBytes / memory.limitBytes) * 100,
        );
        const error = new Error(
          `Agent run aborted because service memory reached ${percentage}% of its container limit`,
        );
        logger.error(`[memory] ${error.message}`);
        abortController.abort(error);
      })
      .finally(() => {
        reading = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
