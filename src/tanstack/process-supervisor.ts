import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { EventType, type StreamChunk } from "@tanstack/ai";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
export const DEFAULT_SERVICE_MEMORY_MB = 4_096;
export const DEFAULT_CGROUP_MEMORY_HEADROOM_MB = 768;
export const DEFAULT_AGENT_TREE_MEMORY_MB =
  DEFAULT_SERVICE_MEMORY_MB - DEFAULT_CGROUP_MEMORY_HEADROOM_MB;

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

export interface AgentProcessSupervisorOptions {
  runId: string;
  abortController: AbortController;
  treeLimitBytes: number;
  cgroupHeadroomBytes: number;
  sampleIntervalMs?: number;
  logIntervalMs?: number;
  readProcesses?: () => Promise<ProcessMemoryEntry[]>;
  readHostMemory?: () => Promise<HostMemorySnapshot>;
  onMemorySample?: (sample: AgentMemorySample) => void | Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
}

export class AgentMemoryLimitError extends Error {
  readonly code = "AGENT_MEMORY_LIMIT";

  constructor(
    readonly runId: string,
    readonly reason: "process-tree" | "service-cgroup",
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `Agent run exceeded its memory limit (${reason}: ${formatMib(observedBytes)} MiB used, ${formatMib(limitBytes)} MiB limit)`,
    );
    this.name = "AgentMemoryLimitError";
  }
}

function formatMib(bytes: number): string {
  return (bytes / MIB).toFixed(0);
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
 * Observes only the process groups spawned for one harness run. The service
 * cgroup is a separate last-resort guard because filesystem page cache is not
 * represented in process RSS but still counts toward Render's memory limit.
 */
export class AgentProcessSupervisor {
  private readonly rootPids = new Set<number>();
  private readonly readProcesses: () => Promise<ProcessMemoryEntry[]>;
  private readonly readHostMemory: () => Promise<HostMemorySnapshot>;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly sampleIntervalMs: number;
  private readonly logIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private samplePromise: Promise<void> | undefined;
  private lastLoggedAt = 0;
  private limitErrorValue: AgentMemoryLimitError | undefined;
  private stopped = false;

  constructor(private readonly options: AgentProcessSupervisorOptions) {
    this.readProcesses = options.readProcesses ?? readProcessTable;
    this.readHostMemory = options.readHostMemory ?? readHostMemory;
    this.logger = options.logger ?? console;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
    this.logIntervalMs = options.logIntervalMs ?? 30_000;
  }

  get limitError(): AgentMemoryLimitError | undefined {
    return this.limitErrorValue;
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
    if (this.stopped || this.limitErrorValue || this.rootPids.size === 0) return;
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

  async *guard(
    stream: AsyncIterable<StreamChunk>,
    model: string,
  ): AsyncIterable<StreamChunk> {
    let sawTerminal = false;
    try {
      for await (const chunk of stream) {
        if (
          this.limitErrorValue &&
          (chunk.type === EventType.RUN_ERROR ||
            chunk.type === EventType.RUN_FINISHED)
        ) {
          sawTerminal = true;
          yield this.errorChunk(model);
          return;
        }
        if (
          chunk.type === EventType.RUN_ERROR ||
          chunk.type === EventType.RUN_FINISHED
        ) {
          sawTerminal = true;
        }
        yield chunk;
      }
    } catch (error) {
      if (!this.limitErrorValue) throw error;
    }

    if (this.limitErrorValue && !sawTerminal) {
      yield this.errorChunk(model);
    }
  }

  private errorChunk(model: string): StreamChunk {
    const error = this.limitErrorValue!;
    return {
      type: EventType.RUN_ERROR,
      model,
      timestamp: Date.now(),
      message: error.message,
      code: error.code,
    };
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
      const cgroupThreshold =
        hostMemory.limitBytes === undefined
          ? undefined
          : Math.max(0, hostMemory.limitBytes - this.options.cgroupHeadroomBytes);
      const treeThreshold =
        cgroupThreshold === undefined
          ? this.options.treeLimitBytes
          : Math.min(this.options.treeLimitBytes, cgroupThreshold);
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

      if (treeBytes >= treeThreshold) {
        this.trip(
          "process-tree",
          treeBytes,
          treeThreshold,
          tree,
          hostMemory,
        );
        return;
      }
      if (
        hostMemory.usageBytes !== undefined &&
        cgroupThreshold !== undefined &&
        hostMemory.usageBytes >= cgroupThreshold
      ) {
        this.trip(
          "service-cgroup",
          hostMemory.usageBytes,
          cgroupThreshold,
          tree,
          hostMemory,
        );
        return;
      }

      const now = Date.now();
      if (now - this.lastLoggedAt >= this.logIntervalMs) {
        this.lastLoggedAt = now;
        this.logger.log(
          `[process-supervisor] run=${this.options.runId} roots=${[...this.rootPids].join(",")} tree-rss-mib=${formatMib(treeBytes)} cgroup-mib=${hostMemory.usageBytes === undefined ? "unknown" : formatMib(hostMemory.usageBytes)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[process-supervisor] run=${this.options.runId} sample failed: ${message}`,
      );
    }
  }

  private logObserverFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `[process-supervisor] run=${this.options.runId} memory observer failed: ${message}`,
    );
  }

  private trip(
    reason: AgentMemoryLimitError["reason"],
    observedBytes: number,
    limitBytes: number,
    tree: ProcessMemoryEntry[],
    hostMemory: HostMemorySnapshot,
  ): void {
    if (this.limitErrorValue) return;
    const error = new AgentMemoryLimitError(
      this.options.runId,
      reason,
      observedBytes,
      limitBytes,
    );
    this.limitErrorValue = error;
    this.stop();
    const top = [...tree]
      .sort((left, right) => right.rssBytes - left.rssBytes)
      .slice(0, 8)
      .map(
        (entry) =>
          `${entry.pid}:${entry.name}:${formatMib(entry.rssBytes)}MiB`,
      )
      .join(",");
    this.logger.warn(
      `[process-supervisor] run=${this.options.runId} aborting reason=${reason} tree-rss-mib=${formatMib(tree.reduce((total, entry) => total + entry.rssBytes, 0))} cgroup-mib=${hostMemory.usageBytes === undefined ? "unknown" : formatMib(hostMemory.usageBytes)} top=${top || "none"}`,
    );
    this.options.abortController.abort(error);
  }
}

function configuredMib(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value * MIB : fallback * MIB;
}

export function configuredAgentMemoryLimits(
  env: NodeJS.ProcessEnv,
): Pick<
  AgentProcessSupervisorOptions,
  "treeLimitBytes" | "cgroupHeadroomBytes"
> {
  return {
    treeLimitBytes: configuredMib(
      env,
      "COMPADRE_AGENT_TREE_MEMORY_MB",
      DEFAULT_AGENT_TREE_MEMORY_MB,
    ),
    cgroupHeadroomBytes: configuredMib(
      env,
      "COMPADRE_CGROUP_MEMORY_HEADROOM_MB",
      DEFAULT_CGROUP_MEMORY_HEADROOM_MB,
    ),
  };
}

export function createAgentProcessSupervisor(
  runId: string,
  abortController: AbortController,
  env: NodeJS.ProcessEnv = process.env,
  onMemorySample?: (sample: AgentMemorySample) => void | Promise<void>,
): AgentProcessSupervisor {
  return new AgentProcessSupervisor({
    runId,
    abortController,
    ...configuredAgentMemoryLimits(env),
    onMemorySample,
  });
}
