import { providerActionFromText, type MessageId } from "@t3tools/contracts";
import type { ChatMessage, Thread } from "./types";

/** T3's compact-command presentation; match the server's exact action admission. */
export function isCompactCommandMessage(
  message: Pick<ChatMessage, "role" | "text" | "attachments">,
) {
  return (
    message.role === "user" &&
    !message.attachments?.length &&
    providerActionFromText(message.text)?.type === "compact"
  );
}

/** Native interruption receipts survive checkpoint completion and later turns. */
export function deriveCancelledCompactionMessageIds(
  thread: Pick<Thread, "messages" | "activities"> | undefined,
) {
  const cancelled = new Set<MessageId>();
  if (!thread) return cancelled;
  const userMessages = thread.messages.filter((message) => message.role === "user");
  for (const activity of thread.activities) {
    if (
      activity.kind !== "provider.turn.completed" ||
      typeof activity.payload !== "object" ||
      activity.payload === null ||
      !("state" in activity.payload) ||
      activity.payload.state !== "interrupted"
    )
      continue;
    const completedAt = Date.parse(activity.createdAt);
    const message = userMessages.findLast(
      (message) => Date.parse(message.createdAt) <= completedAt,
    );
    if (message && isCompactCommandMessage(message)) cancelled.add(message.id);
  }
  return cancelled;
}

/** Based on upstream #9293, with hosted native receipt/timestamp correlation. */
export function isCompactionInProgress(input: {
  thread: Pick<Thread, "messages" | "activities"> | undefined;
  optimisticMessages: ReadonlyArray<ChatMessage>;
  isWorking: boolean;
}) {
  if (!input.isWorking) return false;
  const message =
    input.optimisticMessages.at(-1) ??
    input.thread?.messages.findLast((message) => message.role === "user");
  if (!message || !isCompactCommandMessage(message)) return false;
  const requestedAt = Date.parse(message.createdAt);
  return !input.thread?.activities.some((activity) => {
    if (
      !["context-compaction", "provider.turn.start.failed", "runtime.error"].includes(activity.kind)
    )
      return false;
    return Date.parse(activity.createdAt) >= requestedAt;
  });
}
