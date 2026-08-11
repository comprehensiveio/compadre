import {
  InMemoryRunStore,
  memoryStream,
  type RunStore,
  type StreamChunk,
  type StreamDurability,
} from "@tanstack/ai";
import { RunController } from "@tanstack/ai-sandbox";
import { createPostgresAgentRunDurability } from "./postgres.js";

export type DurabilityBackend = "memory" | "postgres";

export interface AgentRunDurability {
  backend: DurabilityBackend;
  runs: RunStore;
  stream(runId: string): StreamDurability<string>;
  close(): Promise<void>;
}

let configuredDurability: Promise<AgentRunDurability | null> | undefined;

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
    return {
      backend,
      runs,
      stream: (runId) => memoryStream({ runId }),
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
  configuredDurability ??= createAgentRunDurability();
  return configuredDurability;
}

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
    durability: options.durability.stream,
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

export function resetConfiguredAgentRunDurabilityForTests(): void {
  configuredDurability = undefined;
}
