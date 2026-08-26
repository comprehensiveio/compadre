import crypto from "node:crypto";
import type { ConversationResult } from "../conversation.js";
import { parseAgentRouteDirective } from "./agent-routing.js";
import {
  configuredConversationRunner,
  type ConversationRunner,
} from "./conversation-runner.js";
import {
  runSlackConversation,
  type SlackConversationOutcome,
} from "./slack-conversation.js";
import { buildSlackAgentInput } from "./slack-prompt.js";

export interface SlackSimulationOptions {
  messageText: string;
  channel?: string;
  channelName?: string | null;
  threadTs?: string;
  threadContext?: string | null;
  userId?: string;
  runId?: string;
  runner?: ConversationRunner;
  onTextDelta?(text: string): void;
  onToolStart?(name: string): void;
  onAutoContinue?(): void;
}

export interface SlackSimulationResult {
  channel: string;
  threadTs: string;
  prompt: string;
  transcriptUserMessage: string;
  output: string;
  tools: string[];
  runIds: string[];
  outcome: SlackConversationOutcome;
}

/**
 * Exercise the Slack-shaped conversation path without making Slack API calls.
 * Only transport delivery is simulated; Modal execution and durable thread
 * behavior are identical to the real Slack route when the configured runner is
 * used.
 */
export async function runSlackSimulation({
  messageText,
  channel = "D_SLACK_SIMULATION",
  channelName = "compadre-simulation",
  threadTs = `simulation-${Date.now()}`,
  threadContext = null,
  userId = "U_SLACK_SIMULATION",
  runId = crypto.randomUUID(),
  runner = configuredConversationRunner(),
  onTextDelta,
  onToolStart,
  onAutoContinue,
}: SlackSimulationOptions): Promise<SlackSimulationResult> {
  const route = parseAgentRouteDirective(messageText.trim());
  if (!route.ok) throw new Error(route.error);

  const input = buildSlackAgentInput({
    messageText: route.messageText,
    threadContext,
    channel,
    channelName,
    threadTs,
    userId,
  });
  let output = "";
  const tools: string[] = [];
  const runIds: string[] = [];

  const outcome = await runSlackConversation({
    runner,
    options: {
      runId,
      prompt: input.prompt,
      transcriptUserMessage: input.transcriptUserMessage,
      threadId: threadTs,
      profile: route.profile,
    },
    delivery: {
      appendText(text) {
        output += text;
        onTextDelta?.(text);
        return true;
      },
      hasTruncatedContent: () => false,
      onToolStart(name) {
        tools.push(name);
        onToolStart?.(name);
      },
      onAutoContinue() {
        onAutoContinue?.();
      },
      onRunStart(nextRunId) {
        runIds.push(nextRunId);
      },
    },
  });

  return {
    channel,
    threadTs,
    prompt: input.prompt,
    transcriptUserMessage: input.transcriptUserMessage,
    output,
    tools,
    runIds,
    outcome,
  };
}

export function slackSimulationSummary(
  simulation: SlackSimulationResult,
): Pick<
  SlackSimulationResult,
  "channel" | "threadTs" | "output" | "tools" | "runIds"
> & {
  autoContinued: boolean;
  result: ConversationResult;
} {
  return {
    channel: simulation.channel,
    threadTs: simulation.threadTs,
    output: simulation.output,
    tools: simulation.tools,
    runIds: simulation.runIds,
    autoContinued: simulation.outcome.autoContinued,
    result: simulation.outcome.result,
  };
}
