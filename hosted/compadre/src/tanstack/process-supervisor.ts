import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export interface ProcessMemoryEntry {
  pid: number;
  ppid: number;
  rssBytes: number;
  name: string;
}

export interface HostMemorySnapshot {
  usageBytes?: number;
  limitBytes?: number;
}

export interface AgentMemorySample {
  treeRssBytes: number;
  hostUsageBytes?: number;
  hostLimitBytes?: number;
}

export interface AgentProcessMonitorOptions {
  runId: string;
  sampleIntervalMs?: number;
  logIntervalMs?: number;
  readProcesses?: () => Promise<ProcessMemoryEntry[]>;
  readHostMemory?: () => Promise<HostMemorySnapshot>;
  onMemorySample?: (sample: AgentMemorySample) => void | Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
}

function formatMib(bytes: number): string {
  return (bytes / MIB).toFixed(0);
}

function formatPercent(usageBytes?: number, limitBytes?: number): string {
  if (usageBytes === undefined || limitBytes === undefined || limitBytes <= 0) {
    return "unknown";
  }
  return ((usageBytes / limitBytes) * 100).toFixed(1);
}

export function parseProcessTable(output: string): ProcessMemoryEntry[] {
  const entries: ProcessMemoryEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      // `comm`, unlike `args`, contains no prompt, token, or MCP bearer value.
      name: match[4]!,
    });
  }
  return entries;
}

export async function readProcessTable(): Promise<ProcessMemoryEntry[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,ppid=,rss=,comm="],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return parseProcessTable(stdout);
}

async function readNumber(path: string): Promise<number | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (value === "max") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read Linux cgroup v2 first, then the legacy v1 memory controller. */
export async function readHostMemory(): Promise<HostMemorySnapshot> {
  const usageBytes =
    (await readNumber("/sys/fs/cgroup/memory.current")) ??
    (await readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
  const limitBytes =
    (await readNumber("/sys/fs/cgroup/memory.max")) ??
    (await readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  return { usageBytes, limitBytes };
}

export function processTree(
  entries: ProcessMemoryEntry[],
  rootPids: ReadonlySet<number>,
): ProcessMemoryEntry[] {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }

  const descendants = new Set(rootPids);
  const pending = [...rootPids];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return entries.filter((entry) => descendants.has(entry.pid));
}

/**
 * Observes the process groups spawned for one harness run. Workflow tasks are
 * isolated at the service boundary, so memory enforcement belongs to the
 * platform cgroup; this monitor never intercepts the stream or aborts a run.
 */
export class AgentProcessMonitor {
  private readonly rootPids = new Set<number>();
  private readonly readProcesses: () => Promise<ProcessMemoryEntry[]>;
  private readonly readHostMemory: () => Promise<HostMemorySnapshot>;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly sampleIntervalMs: number;
  private readonly logIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private samplePromise: Promise<void> | undefined;
  private lastLoggedAt = 0;
  private stopped = false;

  constructor(private readonly options: AgentProcessMonitorOptions) {
    this.readProcesses = options.readProcesses ?? readProcessTable;
    this.readHostMemory = options.readHostMemory ?? readHostMemory;
    this.logger = options.logger ?? console;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
    this.logIntervalMs = options.logIntervalMs ?? 30_000;
  }

  trackRoot(pid: number): void {
    if (this.stopped || !Number.isInteger(pid) || pid <= 0) return;
    this.rootPids.add(pid);
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.sampleIntervalMs);
    this.timer.unref();
  }

  async sample(): Promise<void> {
    if (this.stopped || this.rootPids.size === 0) return;
    if (this.samplePromise) return this.samplePromise;
    this.samplePromise = this.sampleOnce().finally(() => {
      this.samplePromise = undefined;
    });
    return this.samplePromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sampleOnce(): Promise<void> {
    try {
      const [entries, hostMemory] = await Promise.all([
        this.readProcesses(),
        this.readHostMemory(),
      ]);
      if (this.stopped) return;
      const tree = processTree(entries, this.rootPids);
      const treeBytes = tree.reduce((total, entry) => total + entry.rssBytes, 0);
      try {
        const observation = this.options.onMemorySample?.({
          treeRssBytes: treeBytes,
          hostUsageBytes: hostMemory.usageBytes,
          hostLimitBytes: hostMemory.limitBytes,
        });
        if (observation) {
          void observation.catch((error) => this.logObserverFailure(error));
        }
      } catch (error) {
        this.logObserverFailure(error);
      }

      const now = Date.now();
      if (now - this.lastLoggedAt >= this.logIntervalMs) {
        this.lastLoggedAt = now;
        this.logger.log(
          `[process-monitor] run=${this.options.runId} roots=${[...this.rootPids].join(",")} tree-rss-mib=${formatMib(treeBytes)} cgroup-mib=${hostMemory.usageBytes === undefined ? "unknown" : formatMib(hostMemory.usageBytes)} cgroup-limit-mib=${hostMemory.limitBytes === undefined ? "unknown" : formatMib(hostMemory.limitBytes)} cgroup-percent=${formatPercent(hostMemory.usageBytes, hostMemory.limitBytes)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[process-monitor] run=${this.options.runId} sample failed: ${message}`,
      );
    }
  }

  private logObserverFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `[process-monitor] run=${this.options.runId} memory observer failed: ${message}`,
    );
  }
}

export function createAgentProcessMonitor(
  runId: string,
  onMemorySample?: (sample: AgentMemorySample) => void | Promise<void>,
): AgentProcessMonitor {
  return new AgentProcessMonitor({ runId, onMemorySample });
}
