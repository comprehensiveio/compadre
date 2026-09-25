import type { ConversationResult } from "../conversation.js";
import { isModalSpendLimitError } from "../modal-errors.js";

export const INCOMPLETE_RESPONSE_NOTICE =
  ":warning: The agent stopped before finishing its answer; reply `@Compadre continue` to try continuing.";

export const AGENT_FAILURE_NOTICE =
  ":warning: The run stopped unexpectedly; reply `@Compadre continue` to try continuing.";

export const MODAL_SPEND_LIMIT_NOTICE =
  ":warning: The Modal workspace reached its spend limit; an admin needs to raise the limit before you retry.";

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
  if (isModalSpendLimitError(error)) return MODAL_SPEND_LIMIT_NOTICE;

  // Match saved error summaries, never relay arbitrary provider text or tool data.
  // Delivery takes precedence: a failed sync does not establish an agent failure.
  const messages = failureMessages(error);
  for (const [pattern, notice] of FAILURE_NOTICES) {
    if (messages.some((message) => pattern.test(message))) return notice;
  }
  return AGENT_FAILURE_NOTICE;
}

const FAILURE_NOTICES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /event delivery is blocked|event delivery blocked/i,
    ":warning: Syncing the agent's output failed; a Compadre maintainer needs to recover delivery before you retry.",
  ],
  [
    /context_length_exceeded|maximum context length|context window.*(?:exceed|full)|exceed.*context window/i,
    ":warning: The conversation exceeded the model's context limit; start a new thread with a shorter request.",
  ],
  [
    /rate_limit_exceeded|rate limit(?: reached| exceeded)|too many requests/i,
    ":warning: The service hit a rate limit; wait briefly, then reply `@Compadre continue` to retry.",
  ],
  [
    /invalid_api_key|incorrect api key|authentication failed|unauthorized/i,
    ":warning: Service authentication failed; a Compadre maintainer needs to check credentials before you retry.",
  ],
  [
    /request entity too large|payload too large|request body.*too large/i,
    ":warning: A request exceeded the service's size limit; a Compadre maintainer needs to investigate.",
  ],
  [
    /timed out|timeout/i,
    ":warning: The run stopped after a timeout; reply `@Compadre continue` to try continuing.",
  ],
  [
    /without (?:a )?complete(?: terminal)? response|without a final response|stopped before completing/i,
    INCOMPLETE_RESPONSE_NOTICE,
  ],
];

/** Error causes can cross the Temporal boundary as plain records. */
function failureMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current === "string") {
      messages.push(current.slice(0, 4096));
      break;
    }
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    if ("message" in current && typeof current.message === "string") {
      messages.push(current.message.slice(0, 4096));
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return messages;
}
