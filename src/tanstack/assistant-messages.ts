import { EventType, type StreamChunk } from "@tanstack/ai";

/**
 * Tracks the assistant messages in one AG-UI run and exposes the terminal
 * message separately from provider progress messages.
 */
export class AssistantMessageAccumulator {
  private readonly messages = new Map<string, string>();
  private lastMessageId: string | undefined;

  observe(chunk: StreamChunk): void {
    if (chunk.type === EventType.TEXT_MESSAGE_START) {
      this.lastMessageId = chunk.messageId;
      if (!this.messages.has(chunk.messageId)) {
        this.messages.set(chunk.messageId, "");
      }
      return;
    }

    if (chunk.type !== EventType.TEXT_MESSAGE_CONTENT) return;

    this.lastMessageId = chunk.messageId;
    this.messages.set(
      chunk.messageId,
      `${this.messages.get(chunk.messageId) ?? ""}${chunk.delta}`
    );
  }

  terminalText(): string {
    return this.lastMessageId
      ? (this.messages.get(this.lastMessageId) ?? "")
      : "";
  }
}
