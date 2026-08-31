import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import type { AgentProfile } from "../tanstack/protocol.js";
import { providerForAgentProfile } from "../tanstack/protocol.js";
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
    absoluteTimeoutMs?: number;
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
  const provider = profile ? providerForAgentProfile(profile) : "codex";
  if (provider === "codex") {
    return { instanceId: "codex", model: CODEX_MODEL };
  }
  return {
    instanceId: "claudeAgent",
    model: profile === "fable" ? FABLE_MODEL : DEFAULT_MODEL,
  };
}

function assistantMessagesForDispatch(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): T3ThreadSnapshot["thread"]["messages"] {
  const requestedMessage = snapshot.thread.messages.find(
    (message) => message.id === dispatch.messageId && message.role === "user",
  );
  if (!requestedMessage) return [];

  const latestTurn = snapshot.thread.latestTurn;
  if (!latestTurn) return [];
  const requestedAt = Date.parse(
    requestedMessage.createdAt || dispatch.createdAt,
  );
  const turnRequestedAt = Date.parse(latestTurn.requestedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt ?? "");
  const isSteer = turnRequestedAt < requestedAt;
  if (
    !Number.isFinite(requestedAt) ||
    (!Number.isFinite(turnRequestedAt) &&
      !Number.isFinite(turnCompletedAt)) ||
    (isSteer &&
      (!Number.isFinite(turnCompletedAt) || turnCompletedAt < requestedAt))
  ) {
    return [];
  }

  const turnId = requestedMessage.turnId ?? latestTurn.turnId;
  return snapshot.thread.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      (!isSteer || Date.parse(message.createdAt) >= requestedAt),
  );
}

/**
 * A T3 steer appends another user message to the currently running turn. The
 * final assistant response belongs to the newest such message, so any older
 * Slack/web delivery must relinquish ownership instead of reporting the
 * superseded request as a failure or posting the same answer twice.
 */
export function dispatchWasSuperseded(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): boolean {
  const requestedIndex = snapshot.thread.messages.findIndex(
    (message) => message.id === dispatch.messageId && message.role === "user",
  );
  if (requestedIndex < 0) return false;
  const requested = snapshot.thread.messages[requestedIndex];
  return snapshot.thread.messages
    .slice(requestedIndex + 1)
    .some(
      (message) =>
        message.role === "user" &&
        (requested?.turnId == null ||
          message.turnId == null ||
          message.turnId === requested.turnId),
    );
}

/** Complete provider narration for durable streams and compatibility clients. */
export function assistantTextForDispatch(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): string {
  return assistantMessagesForDispatch(snapshot, dispatch)
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** T3's compact turn result: the designated final assistant message only. */
export function finalAssistantTextForDispatch(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): string {
  const messages = assistantMessagesForDispatch(snapshot, dispatch);
  const finalMessageId = snapshot.thread.latestTurn?.assistantMessageId;
  const finalMessage = finalMessageId
    ? messages.find((message) => message.id === finalMessageId)
    : undefined;
  return (finalMessage ?? messages.at(-1))?.text.trim() ?? "";
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
  const snapshot = await input.gateway.waitForTerminal({
    turn,
    timeoutMs: T3_SLACK_TIMEOUT_MS,
    signal: input.signal,
  });

  const state = snapshot.thread.latestTurn?.state;
  if (state === "error") {
    throw new Error(
      snapshot.thread.session?.lastError || "The T3 agent run failed.",
    );
  }
  if (state === "interrupted") {
    throw new Error("The T3 agent run was interrupted.");
  }
  const output = finalAssistantTextForDispatch(snapshot, turn.dispatch);
  if (!output.trim()) {
    throw new Error(
      "The T3 agent run completed without an assistant response.",
    );
  }
  await input.onTextDelta?.(output);

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
  return `<${detailsUrl}|open session in Compadre web>`;
}
