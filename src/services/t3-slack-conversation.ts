import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import type { AgentProfile } from "../tanstack/protocol.js";
import {
  configuredAgentProvider,
  providerForAgentProfile,
} from "../tanstack/protocol.js";
import type {
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "../t3/client.js";
import type { T3Gateway, T3GatewayTurn } from "../t3/gateway.js";

const T3_SLACK_TIMEOUT_MS = 20 * 60 * 1_000;

export interface T3SlackGateway {
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    displayText?: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  open(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{ pairingUrl: string } | null>;
}

export interface T3SlackConversationResult {
  output: string;
  detailsUrl: string | null;
  modelSelection: T3ModelSelection;
  turn: T3GatewayTurn;
  snapshot: T3ThreadSnapshot;
}

export function nativeT3SlackEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.COMPADRE_T3_SLACK_ENABLED === "true";
}

export function nativeT3ApiEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.COMPADRE_T3_API_ENABLED === "true";
}

export function canonicalSlackThreadId(input: {
  teamId?: string;
  channel: string;
  threadTs: string;
}): string {
  return `slack:${input.teamId?.trim() || "unknown-team"}:${input.channel}:${input.threadTs}`;
}

export function t3ModelSelectionForProfile(
  profile: AgentProfile | undefined,
): T3ModelSelection {
  const provider = profile
    ? providerForAgentProfile(profile)
    : configuredAgentProvider();
  if (provider === "codex") {
    return { instanceId: "codex", model: CODEX_MODEL };
  }
  return {
    instanceId: "claudeAgent",
    model: profile === "fable" ? FABLE_MODEL : DEFAULT_MODEL,
  };
}

export function assistantTextForDispatch(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): string {
  const requestedMessage = snapshot.thread.messages.find(
    (message) => message.id === dispatch.messageId && message.role === "user",
  );
  if (!requestedMessage) return "";

  const latestTurn = snapshot.thread.latestTurn;
  if (!latestTurn) return "";
  const requestedAt = Date.parse(requestedMessage.createdAt || dispatch.createdAt);
  if (Date.parse(latestTurn.requestedAt) < requestedAt) return "";

  const assistant = latestTurn.assistantMessageId
    ? snapshot.thread.messages.find(
        (message) =>
          message.id === latestTurn.assistantMessageId &&
          message.role === "assistant",
      )
    : [...snapshot.thread.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.turnId === latestTurn.turnId,
        );
  return assistant?.text ?? "";
}

function responseDelta(previous: string, next: string): string {
  if (!next || next === previous) return "";
  return next.startsWith(previous) ? next.slice(previous.length) : "";
}

export async function runT3SlackConversation(input: {
  gateway: T3SlackGateway | T3Gateway;
  canonicalThreadId: string;
  title: string;
  prompt: string;
  displayText?: string;
  profile?: AgentProfile;
  signal?: AbortSignal;
  includeDetailsLink?: boolean;
  onTextDelta?(text: string): void | Promise<void>;
}): Promise<T3SlackConversationResult> {
  const modelSelection = t3ModelSelectionForProfile(input.profile);
  const turn = await input.gateway.send({
    canonicalThreadId: input.canonicalThreadId,
    title: input.title,
    text: input.prompt,
    displayText: input.displayText,
    modelSelection,
    signal: input.signal,
  });
  let delivered = "";
  const deliverSnapshot = async (snapshot: T3ThreadSnapshot) => {
    const next = assistantTextForDispatch(snapshot, turn.dispatch);
    const delta = responseDelta(delivered, next);
    if (delta) await input.onTextDelta?.(delta);
    if (next.startsWith(delivered)) delivered = next;
  };
  const snapshot = await input.gateway.waitForTerminal({
    turn,
    timeoutMs: T3_SLACK_TIMEOUT_MS,
    signal: input.signal,
    onSnapshot: deliverSnapshot,
  });
  await deliverSnapshot(snapshot);

  const state = snapshot.thread.latestTurn?.state;
  if (state === "error") {
    throw new Error(snapshot.thread.session?.lastError || "The T3 agent run failed.");
  }
  if (state === "interrupted") {
    throw new Error("The T3 agent run was interrupted.");
  }
  const output = assistantTextForDispatch(snapshot, turn.dispatch);
  if (!output.trim()) {
    throw new Error("The T3 agent run completed without an assistant response.");
  }

  let detailsUrl: string | null = null;
  if (input.includeDetailsLink !== false) {
    const opened = await input.gateway.open({
      canonicalThreadId: input.canonicalThreadId,
      providerInstanceId: modelSelection.instanceId,
      signal: input.signal,
    });
    if (!opened) {
      throw new Error("The T3 thread was not available for hosted viewing.");
    }
    detailsUrl = opened.pairingUrl;
  }
  return {
    output,
    detailsUrl,
    modelSelection,
    turn,
    snapshot,
  };
}

export function t3SlackDetailsMarkdown(detailsUrl: string): string {
  return `<${detailsUrl}|View details in T3>`;
}
