import type { MetadataStore } from "@tanstack/ai-persistence";
import type { T3ModelSelection } from "../t3/client.js";

const NAMESPACE = "compadre.t3.thread-bindings.v1";

export interface T3ThreadBinding {
  canonicalThreadId: string;
  providerInstanceId: string;
  t3ThreadId: string;
  projectId: string;
  sandboxId: string;
  baseUrl: string;
  modelSelection: T3ModelSelection;
  createdAt: string;
  updatedAt: string;
}

function key(canonicalThreadId: string, providerInstanceId: string): string {
  return JSON.stringify([canonicalThreadId, providerInstanceId]);
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
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

/**
 * Durable, credential-free mapping from an external conversation to one T3
 * native provider thread. Environment credentials stay in the connection
 * manager rather than being written to generic chat metadata.
 */
export class T3ThreadBindingStore {
  constructor(private readonly metadata: MetadataStore) {}

  get(
    canonicalThreadId: string,
    providerInstanceId: string,
  ): Promise<T3ThreadBinding | null> {
    return this.read(key(canonicalThreadId, providerInstanceId));
  }

  private async read(bindingKey: string): Promise<T3ThreadBinding | null> {
    const value = await this.metadata.get(NAMESPACE, bindingKey);
    if (value === null) return null;
    if (!isBinding(value)) {
      throw new Error(`Invalid persisted T3 thread binding for ${bindingKey}`);
    }
    return value;
  }

  async bind(binding: T3ThreadBinding): Promise<void> {
    if (binding.modelSelection.instanceId !== binding.providerInstanceId) {
      throw new Error("T3 binding provider does not match its model selection");
    }
    const bindingKey = key(
      binding.canonicalThreadId,
      binding.providerInstanceId,
    );
    const existing = await this.read(bindingKey);
    if (existing && existing.t3ThreadId !== binding.t3ThreadId) {
      throw new Error(
        `T3 thread binding is already assigned to ${existing.t3ThreadId}`,
      );
    }
    await this.metadata.set(NAMESPACE, bindingKey, binding);
  }

  delete(canonicalThreadId: string, providerInstanceId: string): Promise<void> {
    return this.metadata.delete(
      NAMESPACE,
      key(canonicalThreadId, providerInstanceId),
    );
  }
}
