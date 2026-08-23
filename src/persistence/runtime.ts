import { memoryPersistence, type ChatPersistence } from "@tanstack/ai-persistence";
import { InMemoryLockStore, type LockStore } from "@tanstack/ai/locks";
import {
  InMemorySandboxInstanceStore,
  type SandboxInstanceStore,
} from "@tanstack/ai-sandbox";
import { getConfiguredAgentRunDurability } from "../durability/runtime.js";
import {
  createPostgresChatPersistence,
  PostgresLockStore,
  validatePostgresChatPersistenceSchema,
} from "./postgres.js";
import { metadataSandboxInstanceStore } from "../tanstack/sandbox-instance-store.js";

export interface ThreadPersistenceRuntime {
  persistence: ChatPersistence;
  locks: LockStore;
  sandboxInstances: SandboxInstanceStore;
}

let configuredRuntime: Promise<ThreadPersistenceRuntime | null> | undefined;

export async function createThreadPersistenceRuntime(): Promise<ThreadPersistenceRuntime | null> {
  const durability = await getConfiguredAgentRunDurability();
  if (!durability) return null;

  if (durability.backend === "memory") {
    return {
      persistence: memoryPersistence(),
      locks: new InMemoryLockStore(),
      sandboxInstances: new InMemorySandboxInstanceStore(),
    };
  }

  if (!durability.database || !durability.lockPool) {
    throw new Error("Postgres durability did not expose its database resources");
  }
  await validatePostgresChatPersistenceSchema(durability.database);
  const persistence = createPostgresChatPersistence(
      durability.database,
      durability.runs,
    );
  return {
    persistence,
    locks: new PostgresLockStore(durability.lockPool),
    sandboxInstances: metadataSandboxInstanceStore(
      persistence.stores.metadata,
    ),
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

export async function getRequiredThreadPersistence(): Promise<ThreadPersistenceRuntime> {
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime) {
    throw new Error(
      "Thread persistence requires COMPADRE_DURABILITY_BACKEND=memory or postgres",
    );
  }
  return runtime;
}

export function resetConfiguredThreadPersistenceForTests(): void {
  configuredRuntime = undefined;
}
