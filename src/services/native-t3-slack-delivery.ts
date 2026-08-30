import { EventType, type StreamChunk } from "../t3/agui-protocol.js";
import type { HostedSlackBinding } from "./hosted-thread-bindings.js";
import { SlackStream } from "./slack-stream.js";
import { slackFailureNotice } from "./terminal-response.js";
import { humanizeToolName } from "./tool-labels.js";

export interface NativeT3SlackDeliveryStream {
  postThreadMessage(markdownText: string): Promise<void>;
  postThreadContext(markdownText: string): Promise<void>;
  setStatus(text: string): Promise<void>;
  clearStatus(): Promise<void>;
}

function toolName(chunk: StreamChunk): string | null {
  if (chunk.type !== EventType.TOOL_CALL_START) return null;
  return chunk.toolName || chunk.toolCallName || null;
}

/**
 * Mirror a central-web turn into its linked Slack thread while leaving the
 * native T3 event stream authoritative. Slack delivery is deliberately
 * best-effort: a Slack outage must not interrupt the provider run or the web
 * transcript.
 */
export async function* mirrorNativeT3RunToSlack(
  source: AsyncIterable<StreamChunk>,
  input: {
    binding: HostedSlackBinding;
    userMessage: string;
    detailsUrl?: string;
    botToken: string;
  },
  slack: NativeT3SlackDeliveryStream = new SlackStream({
    channel: input.binding.channelId,
    threadTs: input.binding.threadTs,
    botToken: input.botToken,
    recipientUserId: input.binding.recipientUserId,
    recipientTeamId: input.binding.recipientTeamId,
  }),
): AsyncIterable<StreamChunk> {
  let deliveryEnabled = true;
  const assistantMessages = new Map<string, string>();
  let activeAssistantMessageId: string | undefined;
  let terminalError: string | undefined;
  try {
    await slack.postThreadMessage(`*From Compadre web:*
${input.userMessage}`);
    await slack.setStatus("is thinking...");
  } catch (error) {
    deliveryEnabled = false;
    console.error("[native-t3-slack] failed to start Slack mirror", {
      channel: input.binding.channelId,
      threadTs: input.binding.threadTs,
      error,
    });
  }

  try {
    for await (const chunk of source) {
      if (deliveryEnabled) {
        if (chunk.type === EventType.TEXT_MESSAGE_START && chunk.messageId) {
          activeAssistantMessageId = chunk.messageId;
          if (!assistantMessages.has(chunk.messageId)) {
            assistantMessages.set(chunk.messageId, "");
          }
        }
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          const messageId = chunk.messageId ?? activeAssistantMessageId;
          if (messageId) {
            const previous = assistantMessages.get(messageId) ?? "";
            assistantMessages.set(
              messageId,
              typeof chunk.content === "string"
                ? chunk.content
                : `${previous}${chunk.delta ?? ""}`,
            );
          }
        }
        if (chunk.type === EventType.TEXT_MESSAGE_END) {
          activeAssistantMessageId = undefined;
        }
        if (chunk.type === EventType.RUN_ERROR) {
          terminalError = chunk.message || "Native T3 worker failed.";
        }
        const name = toolName(chunk);
        if (name) {
          void slack
            .setStatus(`is ${humanizeToolName(name).toLowerCase()}...`)
            .catch((error) => {
              deliveryEnabled = false;
              console.error("[native-t3-slack] failed to update Slack status", {
                channel: input.binding.channelId,
                threadTs: input.binding.threadTs,
                error,
              });
            });
        }
      }
      yield chunk;
    }
    if (deliveryEnabled) {
      const finalText = [...assistantMessages.values()]
        .reverse()
        .find((text) => text.trim().length > 0);
      if (terminalError) {
        await slack.postThreadMessage(
          slackFailureNotice(new Error(terminalError)),
        );
      } else if (finalText) {
        await slack.postThreadMessage(finalText.trim());
      } else {
        await slack.postThreadMessage(
          slackFailureNotice(
            new Error("Native T3 completed without a final response."),
          ),
        );
      }
      if (input.detailsUrl) {
        await slack.postThreadContext(`<${input.detailsUrl}|Open in web>`);
      }
    }
    await slack.clearStatus().catch(() => undefined);
  } catch (error) {
    if (deliveryEnabled) {
      await slack.clearStatus().catch(() => undefined);
      await slack
        .postThreadMessage(slackFailureNotice(error))
        .catch(() => undefined);
    }
    throw error;
  }
}
