import {
  InMemoryLockStore,
  type LockStore,
  type MetadataStore,
} from "../t3/storage.js";
import {
  decodeT3ThreadSnapshot,
  type T3ThreadSnapshot,
} from "../t3/client.js";
import type { T3ThreadBinding } from "./t3-thread-bindings.js";

const NAMESPACE = "compadre.t3.thread-snapshots.v1";

export interface PersistedT3ThreadSnapshot {
  canonicalThreadId: string;
  t3ThreadId: string;
  snapshot: T3ThreadSnapshot;
  capturedAt: string;
}

function decodePersistedSnapshot(
  canonicalThreadId: string,
  value: unknown,
): PersistedT3ThreadSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid persisted T3 thread snapshot for ${canonicalThreadId}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.canonicalThreadId !== canonicalThreadId ||
    typeof record.t3ThreadId !== "string" ||
    typeof record.capturedAt !== "string"
  ) {
    throw new Error(`Invalid persisted T3 thread snapshot for ${canonicalThreadId}`);
  }
  const snapshot = decodeT3ThreadSnapshot(record.snapshot);
  if (snapshot.thread.id !== record.t3ThreadId) {
    throw new Error(`Persisted T3 thread snapshot identity mismatch for ${canonicalThreadId}`);
  }
  return {
    canonicalThreadId,
    t3ThreadId: record.t3ThreadId,
    snapshot,
    capturedAt: record.capturedAt,
  };
}

/**
 * Central, provider-neutral read model for a native T3 thread. Modal remains
 * the execution worker, but Render-owned persistence keeps the complete T3
 * payload required to render messages, activities, tool calls, and diffs.
 */
export class T3ThreadSnapshotStore {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly locks: LockStore = new InMemoryLockStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(canonicalThreadId: string): Promise<PersistedT3ThreadSnapshot | null> {
    const value = await this.metadata.get(NAMESPACE, canonicalThreadId);
    return value === null ? null : decodePersistedSnapshot(canonicalThreadId, value);
  }

  async save(
    binding: T3ThreadBinding,
    snapshot: T3ThreadSnapshot,
  ): Promise<PersistedT3ThreadSnapshot> {
    if (snapshot.thread.id !== binding.t3ThreadId) {
      throw new Error(
        `T3 snapshot ${snapshot.thread.id} does not match binding ${binding.t3ThreadId}`,
      );
    }
    return this.locks.withLock(
      `compadre:t3-thread-snapshot:${binding.canonicalThreadId}`,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const existing = await this.get(binding.canonicalThreadId);
        if (
          existing &&
          existing.t3ThreadId === binding.t3ThreadId &&
          existing.snapshot.snapshotSequence >= snapshot.snapshotSequence
        ) {
          return existing;
        }
        const persisted: PersistedT3ThreadSnapshot = {
          canonicalThreadId: binding.canonicalThreadId,
          t3ThreadId: binding.t3ThreadId,
          snapshot,
          capturedAt: this.now().toISOString(),
        };
        await this.metadata.set(NAMESPACE, binding.canonicalThreadId, persisted);
        return persisted;
      },
    );
  }

  delete(canonicalThreadId: string): Promise<void> {
    return this.metadata.delete(NAMESPACE, canonicalThreadId);
  }
}
