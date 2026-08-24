import crypto from "node:crypto";
import type {
  ConversationOptions,
  ConversationResult,
} from "../conversation.js";
import type { ConversationRunner } from "./conversation-runner.js";
import {
  IncompleteTerminalResponseError,
  TerminalResponseTracker,
} from "./terminal-response.js";

export const AUTO_CONTINUE_PROMPT = [
  "Continue the previous request from where the prior run stopped.",
  "Use the persisted conversation and investigation history.",
  "Do not repeat completed side effects.",
  "Finish with a concise final answer for the user.",
].join(" ");

const AUTO_CONTINUE_TRANSCRIPT_MESSAGE =
  "[Compadre automatically continued after the prior run ended without a final answer.]";

export interface SlackConversationDelivery {
  appendText(text: string): boolean;
  hasTruncatedContent(): boolean;
  onToolStart(name: string): void;
  onAutoContinue(): void | Promise<void>;
  onRunStart?(runId: string): void | Promise<void>;
}

export interface SlackConversationOutcome {
  result: ConversationResult;
  autoContinued: boolean;
}

interface RunSlackConversationOptions {
  runner: ConversationRunner;
  options: Omit<ConversationOptions, "stream">;
  delivery: SlackConversationDelivery;
}

function streamCallbacks(
  tracker: TerminalResponseTracker,
  delivery: SlackConversationDelivery,
): NonNullable<ConversationOptions["stream"]> {
  return {
    onTextDelta(text) {
      if (delivery.appendText(text)) tracker.recordText(text);
    },
    onToolStart(name) {
      tracker.recordToolStart();
      delivery.onToolStart(name);
    },
  };
}

function canAutoContinue(
  result: ConversationResult,
  tracker: TerminalResponseTracker,
  delivery: SlackConversationDelivery,
): boolean {
  if (delivery.hasTruncatedContent()) return false;
  if (result.finishReason === "content_filter") return false;
  return !tracker.isAgentComplete(result);
}

/** Run one Slack request and make at most one persisted continuation attempt. */
export async function runSlackConversation({
  runner,
  options,
  delivery,
}: RunSlackConversationOptions): Promise<SlackConversationOutcome> {
  let tracker = new TerminalResponseTracker();
  if (options.runId) await delivery.onRunStart?.(options.runId);
  let result = await runner({
    ...options,
    stream: streamCallbacks(tracker, delivery),
  });
  let autoContinued = false;

  if (canAutoContinue(result, tracker, delivery)) {
    autoContinued = true;
    await delivery.onAutoContinue();
    if (delivery.hasTruncatedContent()) {
      throw new IncompleteTerminalResponseError(result.finishReason);
    }
    tracker = new TerminalResponseTracker();
    const continuationOptions = {
      ...options,
      runId: crypto.randomUUID(),
    };
    await delivery.onRunStart?.(continuationOptions.runId);
    const continuedResult = await runner({
      ...continuationOptions,
      prompt: AUTO_CONTINUE_PROMPT,
      transcriptUserMessage: AUTO_CONTINUE_TRANSCRIPT_MESSAGE,
      stream: streamCallbacks(tracker, delivery),
    });
    result = {
      ...continuedResult,
      costUsd: result.costUsd + continuedResult.costUsd,
      durationMs: result.durationMs + continuedResult.durationMs,
      numTurns: result.numTurns + continuedResult.numTurns,
    };
  }

  if (
    !tracker.isComplete(result, {
      truncated: delivery.hasTruncatedContent(),
    })
  ) {
    throw new IncompleteTerminalResponseError(result.finishReason);
  }

  return { result, autoContinued };
}
