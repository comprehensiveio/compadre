import {
  defineSandboxInstanceStore,
  type SandboxInstanceRecord,
  type SandboxInstanceStore,
} from "@tanstack/ai-sandbox";
import type { MetadataStore } from "@tanstack/ai-persistence";

const NAMESPACE = "compadre.modal.sandbox-instances";

function isRecord(value: unknown): value is SandboxInstanceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" &&
    typeof record.provider === "string" &&
    typeof record.providerSandboxId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.updatedAt === "number";
}

/** Persist TanStack's thread-to-Modal mapping in the existing metadata store. */
export function metadataSandboxInstanceStore(
  metadata: MetadataStore,
): SandboxInstanceStore {
  return defineSandboxInstanceStore({
    async get(key) {
      const value = await metadata.get(NAMESPACE, key);
      if (value === null) return null;
      if (!isRecord(value)) {
        throw new Error(`Invalid persisted sandbox instance record for ${key}`);
      }
      return value;
    },
    upsert(record) {
      return metadata.set(NAMESPACE, record.key, record);
    },
    delete(key) {
      return metadata.delete(NAMESPACE, key);
    },
  });
}
