import type { MetadataStore } from "@tanstack/ai-persistence";

const NAMESPACE = "compadre.hosted.thread-bindings";

export interface HostedSlackBinding {
  channelId: string;
  threadTs: string;
  recipientUserId?: string;
  recipientTeamId?: string;
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
}
