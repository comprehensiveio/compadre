import { EventType, type StreamChunk } from "../t3/agui-protocol.js";
import { log, serializeError } from "../logging.js";
import type { HostedSlackBinding } from "./hosted-thread-bindings.js";
import type { SlackSessionLink } from "./slack-markdown.js";
import { SlackStream } from "./slack-stream.js";
import { t3SlackSessionLink } from "./t3-slack-conversation.js";
import {
  AGENT_STOPPED_NOTICE,
  slackFailureNotice,
} from "./terminal-response.js";
import { humanizeToolName } from "./tool-labels.js";

export interface NativeT3SlackDeliveryStream {
  postThreadMessage(
    markdownText: string,
    clientMsgId?: string,
    sessionLink?: SlackSessionLink,
  ): Promise<void>;
  setStatus(text: string): Promise<void>;
  clearStatus(): Promise<void>;
}

function toolName(chunk: StreamChunk): string | null {
  if (chunk.type !== EventType.TOOL_CALL_START) return null;
  return chunk.toolName || chunk.toolCallName || null;
}

/**
 * Observer-form Slack mirror for the durable run driver. Unlike the
 * generator wrapper below, it never treats a driver exception as terminal:
 * a retried drive activity constructs a new mirror with `resume` state and
 * continues, and only an explicit `finish` posts the final message. Slack
 * delivery stays best-effort — a Slack outage must not fail the run.
 */
export class SlackRunMirror {
  private deliveryEnabled = true;
  private readonly assistantMessages: Map<string, string>;
  private activeAssistantMessageId: string | undefined;
  private terminalError: string | undefined;
  private terminalCancelled = false;

  constructor(
    private readonly input: {
      binding: HostedSlackBinding;
      userMessage: string;
      detailsUrl?: string;
      botToken: string;
      shouldDeliverFinal?: () => Promise<boolean>;
    },
    resume?: { assistantTexts?: ReadonlyMap<string, string> },
    private readonly slack: NativeT3SlackDeliveryStream = new SlackStream({
      channel: input.binding.channelId,
      threadTs: input.binding.threadTs,
      botToken: input.botToken,
      recipientUserId: input.binding.recipientUserId,
      recipientTeamId: input.binding.recipientTeamId,
    }),
  ) {
    this.assistantMessages = new Map(resume?.assistantTexts ?? []);
  }

  private disableDelivery(context: string, error: unknown): void {
    this.deliveryEnabled = false;
    log.error(
      {
        deliveryContext: context,
        slackChannelId: this.input.binding.channelId,
        slackThreadTs: this.input.binding.threadTs,
        ...serializeError(error),
      },
      "native t3 slack delivery disabled",
    );
  }

  /** Post the intro exactly once per run — skipped on a resumed driver. */
  async start(): Promise<void> {
    if (!this.deliveryEnabled) return;
    try {
      await this.slack.postThreadMessage(`*From Compadre web:*
${this.input.userMessage}`);
      await this.slack.setStatus("is thinking...");
    } catch (error) {
      this.disableDelivery("failed to start Slack mirror", error);
    }
  }

  observe(chunk: StreamChunk): void {
    if (chunk.type === EventType.TEXT_MESSAGE_START && chunk.messageId) {
      this.activeAssistantMessageId = chunk.messageId;
      if (!this.assistantMessages.has(chunk.messageId)) {
        this.assistantMessages.set(chunk.messageId, "");
      }
    }
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      const messageId = chunk.messageId ?? this.activeAssistantMessageId;
      if (messageId) {
        const previous = this.assistantMessages.get(messageId) ?? "";
        this.assistantMessages.set(
          messageId,
          typeof chunk.content === "string"
            ? chunk.content
            : `${previous}${chunk.delta ?? ""}`,
        );
      }
    }
    if (chunk.type === EventType.TEXT_MESSAGE_END) {
      this.activeAssistantMessageId = undefined;
    }
    if (chunk.type === EventType.RUN_ERROR) {
      this.terminalError = chunk.message || "Native T3 worker failed.";
      this.terminalCancelled = chunk.code === "NATIVE_T3_RUN_CANCELLED";
    }
    if (!this.deliveryEnabled) return;
    const name = toolName(chunk);
    if (name) {
      void this.slack
        .setStatus(`is ${humanizeToolName(name).toLowerCase()}...`)
        .catch((error) =>
          this.disableDelivery("failed to update Slack status", error),
        );
    }
  }

  /** Deliver the final Slack message after the run's terminal event. */
  async finish(): Promise<void> {
    if (!this.deliveryEnabled) return;
    try {
      const ownsFinal = (await this.input.shouldDeliverFinal?.()) ?? true;
      if (!ownsFinal) {
        // A later steer owns the shared Slack status and final answer.
        return;
      }
      const finalText = [...this.assistantMessages.values()]
        .reverse()
        .find((text) => text.trim().length > 0);
      // The session link rides inside the final message as a context footer
      // rather than a second message.
      const sessionLink = this.input.detailsUrl
        ? t3SlackSessionLink(this.input.detailsUrl)
        : undefined;
      if (this.terminalCancelled) {
        await this.slack.postThreadMessage(
          AGENT_STOPPED_NOTICE,
          undefined,
          sessionLink,
        );
      } else if (this.terminalError) {
        await this.slack.postThreadMessage(
          slackFailureNotice(new Error(this.terminalError)),
          undefined,
          sessionLink,
        );
      } else if (finalText) {
        await this.slack.postThreadMessage(
          finalText.trim(),
          undefined,
          sessionLink,
        );
      } else {
        await this.slack.postThreadMessage(
          slackFailureNotice(
            new Error("Native T3 completed without a final response."),
          ),
          undefined,
          sessionLink,
        );
      }
    } catch (error) {
      this.disableDelivery("failed to deliver the final Slack mirror", error);
    }
    await this.slack.clearStatus().catch(() => undefined);
  }
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
    shouldDeliverFinal?: () => Promise<boolean>;
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
  let terminalCancelled = false;
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
          terminalCancelled = chunk.code === "NATIVE_T3_RUN_CANCELLED";
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
      const ownsFinal = (await input.shouldDeliverFinal?.()) ?? true;
      if (!ownsFinal) {
        // A later steer owns the shared Slack status and final answer. Its
        // delivery path will settle both, so this older mirror exits quietly.
        return;
      }
      const finalText = [...assistantMessages.values()]
        .reverse()
        .find((text) => text.trim().length > 0);
      // The session link rides inside the final message as a context footer
      // rather than a second message.
      const sessionLink = input.detailsUrl
        ? t3SlackSessionLink(input.detailsUrl)
        : undefined;
      if (terminalCancelled) {
        await slack.postThreadMessage(
          AGENT_STOPPED_NOTICE,
          undefined,
          sessionLink,
        );
      } else if (terminalError) {
        await slack.postThreadMessage(
          slackFailureNotice(new Error(terminalError)),
          undefined,
          sessionLink,
        );
      } else if (finalText) {
        await slack.postThreadMessage(finalText.trim(), undefined, sessionLink);
      } else {
        await slack.postThreadMessage(
          slackFailureNotice(
            new Error("Native T3 completed without a final response."),
          ),
          undefined,
          sessionLink,
        );
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
