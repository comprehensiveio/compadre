import type { MetadataStore } from "@tanstack/ai-persistence";

const NAMESPACE = "compadre.hosted.thread-bindings";
const ALIAS_NAMESPACE = "compadre.hosted.thread-aliases";
const MAX_ALIAS_DEPTH = 16;

export interface HostedSlackBinding {
  channelId: string;
  threadTs: string;
  recipientUserId?: string;
  recipientTeamId?: string;
}

interface HostedThreadAlias {
  canonicalThreadId: string;
}

function isHostedSlackBinding(value: unknown): value is HostedSlackBinding {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.channelId === "string" &&
    typeof record.threadTs === "string" &&
    (record.recipientUserId === undefined ||
      typeof record.recipientUserId === "string") &&
    (record.recipientTeamId === undefined ||
      typeof record.recipientTeamId === "string")
  );
}

function isHostedThreadAlias(value: unknown): value is HostedThreadAlias {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.canonicalThreadId === "string" &&
    record.canonicalThreadId.length > 0
  );
}

/** Durable link from a provider-neutral thread to its Slack presentation. */
export class HostedThreadBindingStore {
  constructor(private readonly metadata: MetadataStore) {}

  async bindSlack(
    threadId: string,
    binding: HostedSlackBinding,
  ): Promise<void> {
    await this.metadata.set(NAMESPACE, threadId, binding);
  }

  async slack(threadId: string): Promise<HostedSlackBinding | null> {
    const value = await this.metadata.get(NAMESPACE, threadId);
    if (value === null) return null;
    if (!isHostedSlackBinding(value)) {
      throw new Error(`Invalid hosted Slack binding for thread ${threadId}`);
    }
    return value;
  }

  /**
   * Resolve a client-native thread id to the provider-neutral Compadre thread.
   * Aliases are intentionally followed defensively so an older mapping can be
   * migrated without exposing that indirection to T3, Slack, or Modal.
   */
  async resolve(threadId: string): Promise<string> {
    let current = threadId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
      if (visited.has(current)) {
        throw new Error(`Hosted thread alias cycle detected for ${threadId}`);
      }
      visited.add(current);
      const value = await this.metadata.get(ALIAS_NAMESPACE, current);
      if (value === null) return current;
      if (!isHostedThreadAlias(value)) {
        throw new Error(`Invalid hosted thread alias for ${current}`);
      }
      current = value.canonicalThreadId;
    }
    throw new Error(`Hosted thread alias chain is too deep for ${threadId}`);
  }

  /** Bind a surface-specific id to one stable conversation/workspace id. */
  async bindAlias(
    aliasThreadId: string,
    canonicalThreadId: string,
  ): Promise<void> {
    const canonical = await this.resolve(canonicalThreadId);
    const existing = await this.resolve(aliasThreadId);
    if (existing !== aliasThreadId && existing !== canonical) {
      throw new Error(
        `Hosted thread ${aliasThreadId} is already bound to ${existing}`,
      );
    }
    if (aliasThreadId === canonical || existing === canonical) return;
    await this.metadata.set(ALIAS_NAMESPACE, aliasThreadId, {
      canonicalThreadId: canonical,
    } satisfies HostedThreadAlias);
  }
}
