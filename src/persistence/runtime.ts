import { memoryPersistence, type ChatPersistence } from "@tanstack/ai-persistence";
import { InMemoryLockStore, type LockStore } from "@tanstack/ai/locks";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import {
  createPostgresChatPersistence,
  PostgresLockStore,
  validatePostgresChatPersistenceSchema,
} from "./postgres.js";

export interface ThreadPersistenceRuntime {
  persistence: ChatPersistence;
  locks: LockStore;
}

let configuredRuntime: Promise<ThreadPersistenceRuntime | null> | undefined;

export function isThreadPersistenceEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.COMPADRE_THREAD_PERSISTENCE_ENABLED === "true";
}

export async function createThreadPersistenceRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ThreadPersistenceRuntime | null> {
  if (!isThreadPersistenceEnabled(environment)) return null;

  const durability = await getConfiguredAgentRunDurability();
  if (!durability) {
    throw new Error(
      "Thread persistence requires COMPADRE_DURABILITY_BACKEND=memory or postgres",
    );
  }

  if (durability.backend === "memory") {
    return {
      persistence: memoryPersistence(),
      locks: new InMemoryLockStore(),
    };
  }

  if (!durability.database || !durability.lockPool) {
    throw new Error("Postgres durability did not expose its database resources");
  }
  await validatePostgresChatPersistenceSchema(durability.database);
  return {
    persistence: createPostgresChatPersistence(
      durability.database,
      durability.runs,
    ),
    locks: new PostgresLockStore(durability.lockPool),
  };
}

export function getConfiguredThreadPersistence(): Promise<ThreadPersistenceRuntime | null> {
  if (!configuredRuntime) {
    const initialization = createThreadPersistenceRuntime().catch((error) => {
      if (configuredRuntime === initialization) configuredRuntime = undefined;
      throw error;
    });
    configuredRuntime = initialization;
  }
  return configuredRuntime;
}

export function resetConfiguredThreadPersistenceForTests(): void {
  configuredRuntime = undefined;
}
