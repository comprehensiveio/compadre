import { preTurnStartFailure, type T3ThreadSnapshot } from "./client.js";
import type { StreamChunk } from "./agui-protocol.js";

/** Observe lifecycle for Temporal/Slack. Conversation delivery belongs to the journal. */
export class NativeRunObservation {
  private terminal: boolean;
  readonly assistantTexts = new Map<string, string>();
  constructor(private readonly runId: string, private readonly messageId: string, persisted: Iterable<StreamChunk>) {
    this.terminal = [...persisted].some((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR");
  }
  get isTerminal() { return this.terminal; }
  project(snapshot: T3ThreadSnapshot): StreamChunk[] {
    const message = snapshot.thread.messages.find((entry) => entry.id === this.messageId);
    if (!message) return [];
    this.assistantTexts.clear();
    for (const assistant of snapshot.thread.messages) {
      if (assistant.role === "assistant" && assistant.createdAt >= message.createdAt) this.assistantTexts.set(assistant.id, assistant.text);
    }
    if (this.terminal) return [];
    const failure = preTurnStartFailure(snapshot, this.messageId);
    const turn = snapshot.thread.latestTurn;
    if (!failure && (!turn || turn.state === "running" || !turn.completedAt || turn.completedAt < message.createdAt)) return [];
    this.terminal = true;
    if (!failure && turn?.state === "completed") return [{ type: "RUN_FINISHED", runId: this.runId }];
    return [{ type: "RUN_ERROR", runId: this.runId,
      message: failure?.message ?? snapshot.thread.session?.lastError ?? `Native turn ${turn?.state}.`,
      ...(turn?.state === "interrupted" ? { code: "NATIVE_T3_RUN_CANCELLED" } : {}),
    }];
  }
}
