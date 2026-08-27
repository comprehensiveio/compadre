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
import type { T3SlackGateway } from "./t3-slack-conversation.js";
import {
  canonicalSlackThreadId,
  runT3SlackConversation,
  t3SlackDetailsMarkdown,
} from "./t3-slack-conversation.js";
import { getConfiguredT3Gateway } from "../t3/runtime.js";
import {
  configuredCentralT3Client,
  runCentralT3Conversation,
} from "../t3/central-conversation.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { HostedThreadBindingStore } from "./hosted-thread-bindings.js";

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

export interface T3SlackSimulationResult {
  channel: string;
  threadTs: string;
  canonicalThreadId: string;
  prompt: string;
  transcriptUserMessage: string;
  output: string;
  detailsUrl: string;
  modelSelection: { instanceId: string; model: string };
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

/** Simulate Slack transport while executing the conversation in native T3. */
export async function runT3SlackSimulation({
  messageText,
  channel = "D_SLACK_SIMULATION",
  channelName = "compadre-simulation",
  threadTs = `simulation-${Date.now()}`,
  threadContext = null,
  userId = "U_SLACK_SIMULATION",
  teamId = "T_SLACK_SIMULATION",
  gateway,
  onTextDelta,
}: Omit<SlackSimulationOptions, "runId" | "runner" | "onToolStart" | "onAutoContinue"> & {
  teamId?: string;
  gateway?: T3SlackGateway;
}): Promise<T3SlackSimulationResult> {
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
  const canonicalThreadId = canonicalSlackThreadId({ teamId, channel, threadTs });
  let output = "";
  const deliver = (text: string) => {
    output += text;
    onTextDelta?.(text);
  };
  const centralClient = gateway ? null : configuredCentralT3Client();
  const result = centralClient
    ? await runCentralT3Conversation({
        client: centralClient,
        canonicalThreadId,
        title: input.transcriptUserMessage.slice(0, 200) || "Slack simulation",
        prompt: input.prompt,
        displayText: input.transcriptUserMessage,
        profile: route.profile,
        async onPrepared(prepared) {
          const runtime = await getConfiguredThreadPersistence();
          if (!runtime) return;
          const bindings = new HostedThreadBindingStore(
            runtime.persistence.stores.metadata,
          );
          await bindings.bindAlias(canonicalThreadId, prepared.t3ThreadId);
          await bindings.bindSlack(prepared.t3ThreadId, {
            channelId: channel,
            threadTs,
            recipientUserId: userId,
            recipientTeamId: teamId,
            t3EnvironmentId: prepared.environmentId,
            t3ThreadId: prepared.t3ThreadId,
          });
        },
        onTextDelta: deliver,
      })
    : await (async () => {
        const configuredGateway = gateway ?? (await getConfiguredT3Gateway());
        if (!configuredGateway) {
          throw new Error("Native T3 Slack simulation requires central T3 configuration.");
        }
        return runT3SlackConversation({
          gateway: configuredGateway,
          canonicalThreadId,
          title: input.transcriptUserMessage.slice(0, 200) || "Slack simulation",
          prompt: input.prompt,
          displayText: input.transcriptUserMessage,
          profile: route.profile,
          onTextDelta: deliver,
        });
      })();
  if (!result.detailsUrl) throw new Error("Native T3 Slack simulation did not receive a details link.");
  const details = `\n\n${t3SlackDetailsMarkdown(result.detailsUrl)}`;
  output += details;
  onTextDelta?.(details);
  return {
    channel,
    threadTs,
    canonicalThreadId,
    prompt: input.prompt,
    transcriptUserMessage: input.transcriptUserMessage,
    output,
    detailsUrl: result.detailsUrl,
    modelSelection: result.modelSelection,
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
