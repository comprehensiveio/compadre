import type { RunRecord, RunStore } from "@tanstack/ai";
import type { MetadataStore } from "@tanstack/ai-persistence";

const NAMESPACE = "compadre.slack.agent-runs";

interface SlackRunReference {
  runId: string;
}

function key(channel: string, messageTs: string): string {
  return `${channel}:${messageTs}`;
}

function isSlackRunReference(value: unknown): value is SlackRunReference {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).runId === "string",
  );
}

/** Durable correlation between a Slack reaction target and its agent run. */
export class SlackRunStateStore {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly runs: RunStore,
  ) {}

  async record(
    channel: string,
    messageTs: string,
    runId: string,
  ): Promise<void> {
    await this.metadata.set(NAMESPACE, key(channel, messageTs), { runId });
  }

  async resolve(channel: string, messageTs: string): Promise<RunRecord | null> {
    const reference = await this.metadata.get(
      NAMESPACE,
      key(channel, messageTs),
    );
    if (!isSlackRunReference(reference)) return null;
    return this.runs.get(reference.runId);
  }

  async forget(channel: string, messageTs: string): Promise<void> {
    await this.metadata.delete(NAMESPACE, key(channel, messageTs));
  }
}
