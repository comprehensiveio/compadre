import type { ConversationResult } from "../conversation.js";
import {
  isModalSpendLimitError,
  MODAL_SPEND_LIMIT_ERROR_MESSAGE,
} from "../modal-errors.js";

export const INCOMPLETE_RESPONSE_NOTICE =
  ":warning: I stopped without producing a complete final answer. Reply `@Compadre continue` and I'll pick the investigation back up.";

export const AGENT_FAILURE_NOTICE =
  ":warning: This run stopped unexpectedly. Reply `@Compadre continue` and I'll resume from the saved investigation.";

export const MODAL_SPEND_LIMIT_NOTICE =
  `:warning: ${MODAL_SPEND_LIMIT_ERROR_MESSAGE} A Modal workspace admin needs to raise the limit or update billing. After that, reply \`@Compadre continue\` and I'll resume from the saved investigation.`;

export const AGENT_STOPPED_NOTICE = "Stopped. Send another message to continue.";

/**
 * Tracks whether the user-facing text stream ends with an answer rather than
 * with tool activity. Whitespace-only deltas do not count as a response.
 */
export class TerminalResponseTracker {
  private activitySequence = 0;
  private lastTextSequence = 0;
  private lastToolSequence = 0;

  recordText(text: string): void {
    if (!text.trim()) return;
    this.lastTextSequence = ++this.activitySequence;
  }

  recordToolStart(): void {
    this.lastToolSequence = ++this.activitySequence;
  }

  isAgentComplete(
    result: Pick<ConversationResult, "result" | "finishReason">,
  ): boolean {
    if (!result.result.trim()) return false;
    if (result.finishReason !== null && result.finishReason !== "stop") {
      return false;
    }
    return this.lastTextSequence > this.lastToolSequence;
  }

  isComplete(
    result: Pick<ConversationResult, "result" | "finishReason">,
    delivery: { truncated?: boolean } = {},
  ): boolean {
    return !delivery.truncated && this.isAgentComplete(result);
  }
}

export class IncompleteTerminalResponseError extends Error {
  constructor(finishReason: ConversationResult["finishReason"]) {
    super(
      `Agent stopped without a complete terminal response (finishReason=${finishReason ?? "unknown"})`,
    );
    this.name = "IncompleteTerminalResponseError";
  }
}

export function slackFailureNotice(error: unknown): string {
  if (error instanceof IncompleteTerminalResponseError) {
    return INCOMPLETE_RESPONSE_NOTICE;
  }
  return isModalSpendLimitError(error)
    ? MODAL_SPEND_LIMIT_NOTICE
    : AGENT_FAILURE_NOTICE;
}
