import {
  EventType,
  InMemoryRunStore,
  isTerminalRunStatus,
  memoryStream,
  type RunStore,
  type StreamChunk,
  type StreamDurability,
} from "@tanstack/ai";
import { RunController } from "@tanstack/ai-sandbox";
import type pg from "pg";
import type { CompadreDatabase } from "../db/client.js";
import { createPostgresAgentRunDurability } from "./postgres.js";

export type DurabilityBackend = "memory" | "postgres";

export interface DurableStreamOptions {
  /**
   * How long an empty log may stay empty before a from-start reader fails.
   * Joiners of unknown runs want the backend's fail-fast default; a producer
   * that just started the run passes a deadline covering harness startup.
   */
  firstChunkDeadlineMs?: number;
}

export interface AgentRunDurability {
  backend: DurabilityBackend;
  runs: RunStore;
  stream(runId: string, options?: DurableStreamOptions): StreamDurability<string>;
  pool?: pg.Pool;
  lockPool?: pg.Pool;
  database?: CompadreDatabase;
  close(): Promise<void>;
}

let configuredDurability: Promise<AgentRunDurability | null> | undefined;
const MAX_RETAINED_MEMORY_STREAMS = 100;

export function configuredDurabilityBackend(
  environment: NodeJS.ProcessEnv = process.env,
): DurabilityBackend | null {
  const value = environment.COMPADRE_DURABILITY_BACKEND?.trim();
  if (!value || value === "off") return null;
  if (value === "memory" || value === "postgres") return value;
  throw new Error(
    `COMPADRE_DURABILITY_BACKEND must be off, memory, or postgres; received ${value}`,
  );
}

export async function createAgentRunDurability(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentRunDurability | null> {
  const backend = configuredDurabilityBackend(environment);
  if (backend === null) return null;
  if (backend === "memory") {
    const runs = new InMemoryRunStore();
    const streams = new Map<string, StreamDurability<string>>();
    const completedStreamIds: string[] = [];
    return {
      backend,
      runs,
      stream: (runId, options) => {
        let stream = streams.get(runId);
        if (!stream) {
          const underlying = memoryStream(
            { runId },
            options?.firstChunkDeadlineMs !== undefined
              ? { firstChunkDeadlineMs: options.firstChunkDeadlineMs }
              : {},
          );
          let closed = false;
          stream = {
            resumeFrom: () => underlying.resumeFrom(),
            append: (chunks) => underlying.append(chunks),
            read: (offset, signal) => underlying.read(offset, signal),
            snapshot: () => underlying.snapshot(),
            close: async () => {
              await underlying.close();
              if (closed) return;
              closed = true;
              completedStreamIds.push(runId);
              while (
                completedStreamIds.length > MAX_RETAINED_MEMORY_STREAMS
              ) {
                const expired = completedStreamIds.shift();
                if (expired) streams.delete(expired);
              }
            },
          };
          streams.set(runId, stream);
        }
        return stream;
      },
      close: async () => undefined,
    };
  }

  const connectionString = environment.COMPADRE_DURABILITY_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "COMPADRE_DURABILITY_DATABASE_URL is required when COMPADRE_DURABILITY_BACKEND=postgres",
    );
  }
  const durability = await createPostgresAgentRunDurability({ connectionString });
  return { backend, ...durability };
}

export function getConfiguredAgentRunDurability(): Promise<AgentRunDurability | null> {
  if (!configuredDurability) {
    const initialization = createAgentRunDurability().catch((error) => {
      if (configuredDurability === initialization) {
        configuredDurability = undefined;
      }
      throw error;
    });
    configuredDurability = initialization;
  }
  return configuredDurability;
}

/**
 * A freshly started harness appends nothing until its process spawns and
 * initializes, which takes seconds — far beyond the memory backend's 100ms
 * unknown-run fail-fast. The producer path knows the run is live, so it may
 * wait out startup; external joiners keep the backend default.
 */
const PRODUCER_FIRST_CHUNK_DEADLINE_MS = 60_000;

export function captureDurableRun(
  source: AsyncIterable<StreamChunk>,
  options: {
    runId: string;
    threadId: string;
    signal?: AbortSignal;
    durability: AgentRunDurability;
  },
): AsyncIterable<StreamChunk> {
  const controller = new RunController({
    runs: options.durability.runs,
    durability: (runId) =>
      options.durability.stream(runId, {
        firstChunkDeadlineMs: PRODUCER_FIRST_CHUNK_DEADLINE_MS,
      }),
  });
  const handle = controller.start({
    runId: options.runId,
    threadId: options.threadId,
    stream: source,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return (async function* () {
    try {
      for await (const entry of controller.attach(
        options.runId,
        "-1",
        options.signal,
      )) {
        yield entry.chunk;
      }
    } finally {
      await handle.done;
    }
  })();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terminalize a durable run when its external Workflow process dies. */
export async function failOpenDurableRun(
  durability: AgentRunDurability,
  runId: string,
  error: unknown,
  now: () => number = Date.now,
): Promise<void> {
  const run = await durability.runs.get(runId);
  if (!run) throw new Error(`Cannot fail unknown durable run ${runId}`);

  const stream = durability.stream(runId);
  if (!isTerminalRunStatus(run.status)) {
    const message = errorMessage(error);
    try {
      await stream.append([
        {
          type: EventType.RUN_ERROR,
          message,
          code: "WORKFLOW_TASK_FAILED",
          timestamp: now(),
        },
      ]);
    } catch (appendError) {
      console.warn("[durability] could not append Workflow failure event", {
        runId,
        error: appendError,
      });
    }

    try {
      await durability.runs.update(runId, {
        status: "failed",
        finishedAt: now(),
        error: { message, code: "WORKFLOW_TASK_FAILED" },
      });
    } finally {
      await stream.close();
    }
    return;
  }

  // A task can be terminal while its producer was killed between updating the
  // run record and closing the log. close() is idempotent for both backends.
  await stream.close();
}

export function resetConfiguredAgentRunDurabilityForTests(): void {
  configuredDurability = undefined;
}
