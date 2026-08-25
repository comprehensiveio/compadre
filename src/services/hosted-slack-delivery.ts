import { replayRunStream } from "@tanstack/ai";
import type { AgentRunDurability } from "../durability/runtime.js";
import { ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS } from "../durability/runtime.js";
import { consumeHarnessConversation } from "../tanstack/conversation.js";
import type { AgentProvider } from "../tanstack/protocol.js";
import { SlackStream } from "./slack-stream.js";
import { slackFailureNotice } from "./terminal-response.js";
import { humanizeToolName } from "./tool-labels.js";
import type { HostedSlackBinding } from "./hosted-thread-bindings.js";

export interface HostedSlackDeliveryInput {
  binding: HostedSlackBinding;
  durability: AgentRunDurability;
  runId: string;
  provider: AgentProvider;
  userMessage: string;
  botToken: string;
}

export interface HostedSlackDeliveryStream {
  postThreadMessage(markdownText: string): Promise<void>;
  setStatus(text: string): Promise<void>;
  appendText(text: string): boolean;
  stopStream(): Promise<void>;
  clearStatus(): Promise<void>;
}

export async function deliverHostedRunToSlack(
  {
    binding,
    durability,
    runId,
    provider,
    userMessage,
    botToken,
  }: HostedSlackDeliveryInput,
  slack: HostedSlackDeliveryStream = new SlackStream({
    channel: binding.channelId,
    threadTs: binding.threadTs,
    botToken,
    recipientUserId: binding.recipientUserId,
    recipientTeamId: binding.recipientTeamId,
  }),
): Promise<void> {
  try {
    await slack.postThreadMessage(`*From Compadre web:*
${userMessage}`);
    await slack.setStatus("is thinking...");
    await consumeHarnessConversation(
      replayRunStream(
        durability.stream(runId, {
          firstChunkDeadlineMs: ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS,
        }),
        "-1",
      ),
      {
        runId,
        provider,
        startedAt: Date.now(),
        stream: {
          onTextDelta: (text) => {
            slack.appendText(text);
          },
          onToolStart: (name) => {
            void slack.setStatus(
              `is ${humanizeToolName(name).toLowerCase()}...`,
            );
          },
        },
      },
    );
    await slack.stopStream();
    await slack.clearStatus();
  } catch (error) {
    await slack.stopStream().catch(() => undefined);
    await slack.clearStatus().catch(() => undefined);
    await slack.postThreadMessage(slackFailureNotice(error)).catch(() => undefined);
    throw error;
  }
}

/** Fan a browser-started durable run into its linked Slack thread. */
export function startHostedSlackDelivery(
  input: HostedSlackDeliveryInput,
): void {
  void deliverHostedRunToSlack(input).catch((error) => {
    console.error("[hosted-slack] delivery failed", {
      runId: input.runId,
      channel: input.binding.channelId,
      threadTs: input.binding.threadTs,
      error,
    });
  });
}
