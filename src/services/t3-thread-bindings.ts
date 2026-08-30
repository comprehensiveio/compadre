import {
  InMemoryLockStore,
  type LockStore,
  type MetadataStore,
} from "../t3/storage.js";
import type { T3ModelSelection } from "../t3/client.js";

const NAMESPACE = "compadre.t3.thread-bindings.v2";
const INDEX_KEY = "__index__";
const INDEX_LOCK = "compadre:t3-thread-bindings:index";

export type T3ThreadDirectoryStatus =
  | "working"
  | "ready"
  | "interrupted"
  | "error"
  | "unavailable";

export interface T3ThreadBinding {
  canonicalThreadId: string;
  providerInstanceId: string;
  t3ThreadId: string;
  projectId: string;
  sandboxId: string;
  baseUrl: string;
  modelSelection: T3ModelSelection;
  title?: string;
  status?: T3ThreadDirectoryStatus;
  createdAt: string;
  updatedAt: string;
}

interface T3ThreadBindingIndexEntry {
  canonicalThreadId: string;
}

function key(canonicalThreadId: string): string {
  return canonicalThreadId;
}

function isModelSelection(value: unknown): value is T3ModelSelection {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instanceId === "string" &&
    record.instanceId.length > 0 &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    (record.options === undefined || Array.isArray(record.options))
  );
}

function isBinding(value: unknown): value is T3ThreadBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.canonicalThreadId === "string" &&
    record.canonicalThreadId.length > 0 &&
    typeof record.providerInstanceId === "string" &&
    record.providerInstanceId.length > 0 &&
    typeof record.t3ThreadId === "string" &&
    record.t3ThreadId.length > 0 &&
    typeof record.projectId === "string" &&
    record.projectId.length > 0 &&
    typeof record.sandboxId === "string" &&
    record.sandboxId.length > 0 &&
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0 &&
    isModelSelection(record.modelSelection) &&
    (record.title === undefined || typeof record.title === "string") &&
    (record.status === undefined ||
      ["working", "ready", "interrupted", "error", "unavailable"].includes(
        record.status as string,
      )) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isIndexEntry(value: unknown): value is T3ThreadBindingIndexEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.canonicalThreadId === "string" &&
    record.canonicalThreadId.length > 0
  );
}

/**
 * Durable, credential-free mapping from an external conversation to one native
 * T3 thread. The provider harness is fixed by T3's first turn; models within
 * that provider can change without moving the conversation. Environment credentials stay in the connection
 * manager rather than being written to generic chat metadata.
 */
export class T3ThreadBindingStore {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly locks: LockStore = new InMemoryLockStore(),
  ) {}

  get(
    canonicalThreadId: string,
  ): Promise<T3ThreadBinding | null> {
    return this.read(key(canonicalThreadId));
  }

  private async read(bindingKey: string): Promise<T3ThreadBinding | null> {
    const value = await this.metadata.get(NAMESPACE, bindingKey);
    if (value === null) return null;
    if (!isBinding(value)) {
      throw new Error(`Invalid persisted T3 thread binding for ${bindingKey}`);
    }
    return value;
  }

  private async readIndex(): Promise<T3ThreadBindingIndexEntry[]> {
    const value = await this.metadata.get(NAMESPACE, INDEX_KEY);
    if (value === null) return [];
    if (!Array.isArray(value) || !value.every(isIndexEntry)) {
      throw new Error("Invalid persisted T3 thread binding index");
    }
    return value;
  }

  async list(): Promise<T3ThreadBinding[]> {
    const entries = await this.readIndex();
    const bindings = await Promise.all(
      entries.map((entry) => this.get(entry.canonicalThreadId)),
    );
    return bindings
      .filter((binding): binding is T3ThreadBinding => binding !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Persist one binding without acquiring the global directory-index lock.
   * Callers that already hold a per-thread lock use this method, release that
   * lock, and then call `ensureIndexed` so a finite advisory-lock pool cannot
   * deadlock on nested per-thread + global locks.
   */
  async bindRecord(binding: T3ThreadBinding): Promise<void> {
    const bindingKey = key(binding.canonicalThreadId);
    const existing = await this.read(bindingKey);
    if (existing && existing.t3ThreadId !== binding.t3ThreadId) {
      throw new Error(
        `T3 thread binding is already assigned to ${existing.t3ThreadId}`,
      );
    }
    if (
      existing &&
      existing.providerInstanceId !== binding.providerInstanceId
    ) {
      throw new Error(
        `T3 thread binding is already assigned to provider ${existing.providerInstanceId}`,
      );
    }
    await this.metadata.set(NAMESPACE, bindingKey, binding);
  }

  async ensureIndexed(canonicalThreadId: string): Promise<void> {
    await this.locks.withLock(INDEX_LOCK, async (signal) => {
      if (signal.aborted) throw signal.reason;
      const index = await this.readIndex();
      if (
        !index.some(
          (entry) => entry.canonicalThreadId === canonicalThreadId,
        )
      ) {
        await this.metadata.set(NAMESPACE, INDEX_KEY, [
          ...index,
          {
            canonicalThreadId,
          },
        ] satisfies T3ThreadBindingIndexEntry[]);
      }
    });
  }

  async bind(binding: T3ThreadBinding): Promise<void> {
    await this.bindRecord(binding);
    await this.ensureIndexed(binding.canonicalThreadId);
  }

  delete(canonicalThreadId: string): Promise<void> {
    return this.locks.withLock(INDEX_LOCK, async (signal) => {
      if (signal.aborted) throw signal.reason;
      await this.metadata.delete(
        NAMESPACE,
        key(canonicalThreadId),
      );
      const index = await this.readIndex();
      await this.metadata.set(
        NAMESPACE,
        INDEX_KEY,
        index.filter(
          (entry) => entry.canonicalThreadId !== canonicalThreadId,
        ),
      );
    });
  }
}
