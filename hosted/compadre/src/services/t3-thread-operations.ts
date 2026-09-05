import type { ThreadEnvironmentObservation } from "./thread-environment-observations.js";
import type { RunRecord } from "@tanstack/ai";
import type { AgentRunDurability } from "../durability/runtime.js";
import type {
  T3ThreadBinding,
  T3WorkerState,
} from "./t3-thread-bindings.js";

const ATTENTION_AFTER_MS = 10 * 60 * 1_000;
const STUCK_AFTER_MS = 30 * 60 * 1_000;
const EVENT_LOOKBACK_PER_RUN = 50;

export type T3ThreadOperationalHealth = "healthy" | "attention" | "stuck";
export type T3ContainerStatus =
  | "running"
  | "stopped"
  | "transitioning"
  | "unknown";

export interface T3ThreadOperationEvent {
  id?: string;
  type: string;
  at?: string;
  detail?: string;
}

export interface T3ThreadOperation {
  canonicalThreadId: string;
  providerInstanceId: string;
  workerThreadId: string;
  title: string;
  modelSelection: T3ThreadBinding["modelSelection"];
  status: NonNullable<T3ThreadBinding["status"]>;
  phase: string;
  health: T3ThreadOperationalHealth;
  healthReason: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  environment?: ThreadEnvironmentObservation;
  activitySince?: string;
  recentEvents?: T3ThreadOperationEvent[];
  container: {
    status: T3ContainerStatus;
    workerState?: T3WorkerState;
    sandboxId: string;
    generation: number;
    startedAt?: string;
    warmUntil?: string;
    hasSnapshot?: boolean;
  };
  activeRun?: {
    runId: string;
    status: RunRecord["status"] | "missing";
    startedAt?: string;
    finishedAt?: string;
    driverEpoch?: number;
    idleMs?: number;
    lastEvent?: T3ThreadOperationEvent;
  };
}

export interface T3ThreadOperationsSnapshot {
  generatedAt: string;
  thresholds: {
    attentionAfterMs: number;
    stuckAfterMs: number;
  };
  counts: {
    total: number;
    working: number;
    attention: number;
    stuck: number;
    containersRunning: number;
  };
  threads: T3ThreadOperation[];
}

interface StoredEvent {
  sequence: number;
  chunk: Record<string, unknown>;
  at?: string;
}

interface PostgresStoredEventRow {
  run_id: string;
  sequence: string | number;
  chunk: unknown;
  created_at: Date | string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function boundedDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 237)}...`;
}

function eventToolId(chunk: Record<string, unknown>): string | undefined {
  return (
    stringValue(chunk.toolCallId) ??
    stringValue(chunk.itemId) ??
    stringValue(chunk.id)
  );
}

function eventToolName(chunk: Record<string, unknown>): string | undefined {
  const data = record(chunk.data);
  const item = record(data?.item);
  const server = stringValue(item?.server);
  const tool =
    stringValue(item?.tool) ??
    stringValue(chunk.toolCallName) ??
    stringValue(chunk.toolName) ??
    stringValue(chunk.title);
  return server && tool ? `${server} · ${tool}` : tool;
}

function eventDetail(chunk: Record<string, unknown>): string | undefined {
  const data = record(chunk.data);
  const item = record(data?.item);
  return boundedDetail(
    stringValue(chunk.detail) ??
      stringValue(item?.command) ??
      stringValue(item?.path) ??
      stringValue(data?.command) ??
      stringValue(data?.path),
  );
}

function meaningfulEvent(events: readonly StoredEvent[]): StoredEvent | undefined {
  return [...events]
    .reverse()
    .find((event) => event.chunk.type !== "THREAD_TOKEN_USAGE_UPDATED");
}

function activeTool(events: readonly StoredEvent[]): {
  name: string;
  detail?: string;
  since?: string;
} | undefined {
  const tools = new Map<string, { name: string; detail?: string; since?: string }>();
  for (const event of events) {
    const type = stringValue(event.chunk.type);
    const id = eventToolId(event.chunk);
    if (!id) continue;
    if (type === "TOOL_CALL_START") {
      tools.set(id, {
        name: eventToolName(event.chunk) ?? "Tool",
        ...(event.at ? { since: event.at } : {}),
        ...(eventDetail(event.chunk) ? { detail: eventDetail(event.chunk) } : {}),
      });
    } else if (type === "TOOL_CALL_ARGS") {
      const existing = tools.get(id);
      if (existing) {
        tools.set(id, {
          ...existing,
          ...(eventDetail(event.chunk) ? { detail: eventDetail(event.chunk) } : {}),
        });
      }
    } else if (type === "TOOL_CALL_RESULT" || type === "TOOL_CALL_END") {
      tools.delete(id);
    }
  }
  return [...tools.values()].at(-1);
}

function phaseFor(
  binding: T3ThreadBinding,
  events: readonly StoredEvent[],
): { phase: string; since?: string; lastEvent?: T3ThreadOperationEvent } {
  const latest = meaningfulEvent(events);
  const tool = activeTool(events);
  const event = latest
    ? {
        type: stringValue(latest.chunk.type) ?? "UNKNOWN",
        ...(latest.at ? { at: latest.at } : {}),
        ...(eventDetail(latest.chunk) ? { detail: eventDetail(latest.chunk) } : {}),
      }
    : undefined;
  if (binding.status === "error") return { phase: "Failed", ...(event ? { lastEvent: event } : {}) };
  if (binding.status === "interrupted") return { phase: "Interrupted", ...(event ? { lastEvent: event } : {}) };
  if (binding.status === "unavailable") return { phase: "Unavailable", ...(event ? { lastEvent: event } : {}) };
  if (binding.status !== "working") return { phase: latest?.chunk.type === "RUN_FINISHED" ? "Completed" : "Idle", ...(event ? { lastEvent: event } : {}) };
  const requests = new Map<string, StoredEvent>();
  for (const entry of events) {
    if (entry.chunk.type !== "COMPADRE_AGENT_ACTIVITY") continue;
    const status = stringValue(entry.chunk.status) ?? "";
    const id = stringValue(entry.chunk.toolCallId) ?? status.split(".")[0]!;
    if (status.endsWith(".requested")) requests.set(id, entry);
    if (status.endsWith(".resolved")) requests.delete(id);
  }
  const waiting = [...requests.values()].at(-1);
  if (waiting) {
    return { phase: waiting.chunk.status === "approval.requested" ? "Waiting for approval" : "Waiting for your input", ...(waiting.at ? { since: waiting.at } : {}), ...(event ? { lastEvent: event } : {}) };
  }
  if (tool) {
    return {
      ...(tool.since ? { since: tool.since } : {}),
      phase: `Using ${tool.name}${tool.detail ? `: ${tool.detail}` : ""}`,
      ...(event ? { lastEvent: event } : {}),
    };
  }
  const type = event?.type;
  if (type === "RUN_STARTED") return { phase: "Starting provider", lastEvent: event };
  const streamStart = [...events].reverse().find(entry => entry.chunk.type === "TEXT_MESSAGE_START");
  if (type === "REASONING_CONTENT") return { phase: "Thinking", lastEvent: event };
  if (type?.startsWith("TEXT_MESSAGE_")) {
    return { phase: "Generating response", ...(streamStart?.at ? { since: streamStart.at } : {}), lastEvent: event };
  }
  if (type === "TOOL_CALL_RESULT") {
    return { phase: "Processing tool result", lastEvent: event };
  }
  if (type === "RUN_ERROR") return { phase: "Run failed", lastEvent: event };
  if (type === "RUN_FINISHED") return { phase: "Completed", lastEvent: event };
  if (binding.workerState === "restoring") return { phase: "Restoring container" };
  if (binding.workerState === "hibernating") return { phase: "Saving container snapshot" };
  if (binding.status === "working") {
    return { phase: type ? type.replaceAll("_", " ").toLowerCase() : "Dispatching run" };
  }
  if (binding.workerState === "warm") return { phase: "Idle · container warm" };
  if (binding.workerState === "suspended") return { phase: "Idle · container suspended" };
  return { phase: "Idle" };
}

function containerStatus(workerState: T3WorkerState | undefined): T3ContainerStatus {
  if (workerState === "running" || workerState === "warm") return "running";
  if (workerState === "suspended") return "stopped";
  if (workerState === "hibernating" || workerState === "restoring") {
    return "transitioning";
  }
  return "unknown";
}

function timeMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function healthFor(input: {
  binding: T3ThreadBinding;
  run: RunRecord | null | undefined;
  idleMs: number | undefined;
  nowMs: number;
}): { health: T3ThreadOperationalHealth; reason: string } {
  const { binding, run, idleMs, nowMs } = input;
  if (binding.status === "error" || binding.status === "unavailable") {
    return {
      health: "attention",
      reason: binding.status === "error" ? "The last turn failed" : "The worker is unavailable",
    };
  }
  if (binding.status === "interrupted") {
    return { health: "attention", reason: "The last turn was interrupted" };
  }
  if (binding.status !== "working") {
    return { health: "healthy", reason: "No active turn" };
  }
  const workingForMs = Math.max(0, nowMs - timeMs(binding.updatedAt, nowMs));
  if (!binding.activeRunId) {
    return workingForMs >= ATTENTION_AFTER_MS
      ? { health: "stuck", reason: "Working state has no durable run marker" }
      : { health: "attention", reason: "Waiting for the durable run marker" };
  }
  if (run === null) {
    return { health: "stuck", reason: "The active run record is missing" };
  }
  if (run && run.status !== "running") {
    return {
      health: "stuck",
      reason: `The binding is working but the run is ${run.status}`,
    };
  }
  if (
    binding.workerState &&
    binding.workerState !== "running" &&
    binding.workerState !== "restoring"
  ) {
    return {
      health: "stuck",
      reason: `The active turn's container is ${binding.workerState}`,
    };
  }
  if (idleMs !== undefined && idleMs >= STUCK_AFTER_MS) {
    return {
      health: "stuck",
      reason: `No durable progress for ${Math.round(idleMs / 60_000)} minutes`,
    };
  }
  if (idleMs !== undefined && idleMs >= ATTENTION_AFTER_MS) {
    return {
      health: "attention",
      reason: `Quiet for ${Math.round(idleMs / 60_000)} minutes`,
    };
  }
  return { health: "healthy", reason: "Durable progress is current" };
}

async function eventsForRuns(
  durability: AgentRunDurability,
  runIds: readonly string[],
): Promise<Map<string, StoredEvent[]>> {
  const byRun = new Map<string, StoredEvent[]>();
  if (runIds.length === 0) return byRun;
  if (durability.pool) {
    const result = await durability.pool.query<PostgresStoredEventRow>(
      `with ranked as (
         select run_id, sequence, chunk, created_at,
                row_number() over (partition by run_id order by sequence desc) as event_rank
           from compadre_ai_stream_events
          where run_id = any($1::text[])
       )
       select run_id, sequence, chunk, created_at
         from ranked
        where event_rank <= $2
        order by run_id, sequence`,
      [runIds, EVENT_LOOKBACK_PER_RUN],
    );
    for (const row of result.rows) {
      const chunk = record(row.chunk);
      if (!chunk) continue;
      const events = byRun.get(row.run_id) ?? [];
      events.push({
        sequence: Number(row.sequence),
        chunk,
        at: new Date(row.created_at).toISOString(),
      });
      byRun.set(row.run_id, events);
    }
    return byRun;
  }
  await Promise.all(
    runIds.map(async (runId) => {
      const snapshot = await durability.stream(runId).snapshot();
      const events = snapshot
        .slice(-EVENT_LOOKBACK_PER_RUN)
        .map((entry, index) => ({
          sequence: index,
          chunk: record(entry.chunk) ?? ({ type: "UNKNOWN" } as Record<string, unknown>),
          ...(typeof record(entry.chunk)?.timestamp === "number" ? { at: new Date(record(entry.chunk)!.timestamp as number).toISOString() } : {}),
        }));
      byRun.set(runId, events);
    }),
  );
  return byRun;
}

export async function buildT3ThreadOperationsSnapshot(input: {
  bindings: readonly T3ThreadBinding[];
  durability: AgentRunDurability;
  now?: Date;
  environments?: ReadonlyMap<string, ThreadEnvironmentObservation>;
}): Promise<T3ThreadOperationsSnapshot> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const activeRunIds = input.bindings
    .map((binding) => binding.activeRunId)
    .filter((runId): runId is string => Boolean(runId));
  const [runs, events] = await Promise.all([
    Promise.all(
      activeRunIds.map(async (runId) => [runId, await input.durability.runs.get(runId)] as const),
    ),
    eventsForRuns(input.durability, activeRunIds),
  ]);
  const runById = new Map(runs);
  const threads = input.bindings.map((binding): T3ThreadOperation => {
    const runId = binding.activeRunId;
    const run = runId ? runById.get(runId) : undefined;
    const runEvents = runId ? events.get(runId) ?? [] : [];
    const phase = phaseFor(binding, runEvents);
    const lastStoredEvent = runEvents.at(-1);
    const lastProgressMs = lastStoredEvent?.at
      ? Date.parse(lastStoredEvent.at)
      : run?.startedAt;
    const idleMs =
      lastProgressMs !== undefined && Number.isFinite(lastProgressMs)
        ? Math.max(0, nowMs - lastProgressMs)
        : undefined;
    const health = phase.phase.startsWith("Waiting for ") ? { health: "healthy" as const, reason: phase.phase } : healthFor({ binding, run, idleMs, nowMs });
    return {
      canonicalThreadId: binding.canonicalThreadId,
      providerInstanceId: binding.providerInstanceId,
      workerThreadId: binding.t3ThreadId,
      title: binding.title ?? "Untitled thread",
      modelSelection: binding.modelSelection,
      status: binding.status ?? "ready",
      phase: phase.phase,
      recentEvents: runEvents.filter(event => !["TEXT_MESSAGE_CONTENT", "REASONING_CONTENT", "TOOL_CALL_ARGS", "THREAD_TOKEN_USAGE_UPDATED"].includes(String(event.chunk.type))).slice(-8).map(event => ({ id: String(event.sequence), type: String(event.chunk.type), ...(event.at ? { at: event.at } : {}), ...(eventDetail(event.chunk) ? { detail: eventDetail(event.chunk) } : {}) })),
      health: health.health,
      healthReason: health.reason,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
      ...(binding.lastActiveAt ? { lastActiveAt: binding.lastActiveAt } : {}),
      ...(input.environments?.get(binding.canonicalThreadId) ? { environment: input.environments.get(binding.canonicalThreadId) } : {}),
      ...(phase.since ? { activitySince: phase.since } : {}),
      container: {
        hasSnapshot: Boolean(binding.workerSnapshotId),
        status: containerStatus(binding.workerState),
        ...(binding.workerState ? { workerState: binding.workerState } : {}),
        sandboxId: binding.sandboxId,
        generation: binding.workerGeneration ?? 1,
        ...(binding.sandboxStartedAt ? { startedAt: binding.sandboxStartedAt } : {}),
        ...(binding.warmUntil ? { warmUntil: binding.warmUntil } : {}),
      },
      ...(runId
        ? {
            activeRun: {
              runId,
              status: run?.status ?? "missing",
              ...(run ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
              ...(run?.finishedAt
                ? { finishedAt: new Date(run.finishedAt).toISOString() }
                : {}),
              ...(run?.driverEpoch !== undefined ? { driverEpoch: run.driverEpoch } : {}),
              ...(idleMs !== undefined ? { idleMs } : {}),
              ...(phase.lastEvent ? { lastEvent: phase.lastEvent } : {}),
            },
          }
        : {}),
    };
  });
  const activityAt = (thread: T3ThreadOperation) => [thread.activeRun?.lastEvent?.at, thread.activeRun?.startedAt, thread.lastActiveAt, thread.createdAt].filter((at): at is string => Boolean(at)).sort().at(-1)!;
  threads.sort((left, right) => {
    return (
      activityAt(right).localeCompare(activityAt(left)) ||
      left.canonicalThreadId.localeCompare(right.canonicalThreadId)
    );
  });
  return {
    generatedAt: now.toISOString(),
    thresholds: {
      attentionAfterMs: ATTENTION_AFTER_MS,
      stuckAfterMs: STUCK_AFTER_MS,
    },
    counts: {
      total: threads.length,
      working: threads.filter((thread) => thread.status === "working").length,
      attention: threads.filter((thread) => thread.health === "attention").length,
      stuck: threads.filter((thread) => thread.health === "stuck").length,
      containersRunning: threads.filter((thread) => thread.container.status === "running").length,
    },
    threads,
  };
}
