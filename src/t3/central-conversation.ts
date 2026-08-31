import crypto from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AgentProfile } from "../tanstack/protocol.js";
import {
  finalAssistantTextForDispatch,
  t3ModelSelectionForProfile,
} from "../services/t3-slack-conversation.js";
import {
  T3Client,
  incompleteProviderStopReason,
  type T3InputFile,
  type T3MessageAttribution,
  type T3ModelSelection,
  type T3ThreadSnapshot,
  type T3TurnDispatch,
} from "./client.js";

const CENTRAL_T3_TIMEOUT_MS = 20 * 60 * 1_000;
const CENTRAL_T3_ABSOLUTE_TIMEOUT_MS = 115 * 60 * 1_000;
const MAX_PROVIDER_PROMPT_CHARS = 95_000;
const TRUNCATED_CONTEXT_NOTICE =
  "[Earlier Slack thread context truncated to fit the agent prompt.]";
const SLACK_MESSAGE_PREFIX = "slack-entrypoint:";
const API_MESSAGE_PREFIX = "api-entrypoint:";

export interface CentralT3ConversationClient {
  readonly baseUrl: string;
  environmentDescriptor(
    signal?: AbortSignal,
  ): ReturnType<T3Client["environmentDescriptor"]>;
  snapshot(signal?: AbortSignal): ReturnType<T3Client["snapshot"]>;
  startNewThread(
    input: Parameters<T3Client["startNewThread"]>[0],
  ): Promise<T3TurnDispatch>;
  startTurn(
    input: Parameters<T3Client["startTurn"]>[0],
  ): Promise<T3TurnDispatch>;
  waitForTurnTerminal(
    input: Parameters<T3Client["waitForTurnTerminal"]>[0],
  ): Promise<T3ThreadSnapshot>;
}

export interface CentralT3ConversationPrepared {
  canonicalThreadId: string;
  t3ThreadId: string;
  environmentId: string;
  projectId: string;
  detailsUrl: string;
  modelSelection: T3ModelSelection;
  resumed: boolean;
}

export interface CentralT3ConversationResult extends CentralT3ConversationPrepared {
  output: string;
  dispatch: T3TurnDispatch;
  snapshot: T3ThreadSnapshot;
}

/**
 * Add transport-only context without persisting it as the visible user text.
 * Keep the newest context when Slack history exceeds T3's prompt budget.
 */
export function prependConversationContext(
  context: string,
  prompt: string,
): string {
  const normalized = context.trim();
  if (!normalized) return prompt;
  const separator = "\n\n";
  const contextBudget =
    MAX_PROVIDER_PROMPT_CHARS - prompt.length - separator.length;
  if (contextBudget <= 0) return prompt.slice(0, MAX_PROVIDER_PROMPT_CHARS);
  const boundedContext =
    normalized.length <= contextBudget
      ? normalized
      : contextBudget <= TRUNCATED_CONTEXT_NOTICE.length + 1
        ? normalized.slice(-contextBudget)
        : `${TRUNCATED_CONTEXT_NOTICE}\n${normalized.slice(
            -(contextBudget - TRUNCATED_CONTEXT_NOTICE.length - 1),
          )}`;
  return `${boundedContext}${separator}${prompt}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function toolStatusName(activity: Record<string, unknown>): string {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  const server = stringValue(item?.server);
  const tool = stringValue(item?.tool);
  if (server && tool) return `${server} · ${tool}`;
  if (tool) return tool;
  const providerToolName = stringValue(data?.toolName);
  if (providerToolName) return providerToolName;
  const detail = stringValue(payload?.detail);
  const detailToolName = detail?.match(/^([\p{L}\p{N}_-]+)\s*:/u)?.[1];
  if (detailToolName) return detailToolName;
  const summary = stringValue(activity.summary)
    ?.replace(/\s+started\s*$/iu, "")
    .trim();
  return (
    summary || stringValue(payload?.itemType)?.replaceAll("_", " ") || "Tool"
  );
}

function stableUuid(value: string): string {
  const bytes = crypto
    .createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable native T3 id for one provider-neutral Slack conversation. */
export function centralT3ThreadId(canonicalThreadId: string): string {
  return stableUuid(`compadre:central-t3:thread:${canonicalThreadId}`);
}

export function centralT3DetailsUrl(input: {
  baseUrl: string;
  environmentId: string;
  threadId: string;
}): string {
  return new URL(
    `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`,
    input.baseUrl,
  ).toString();
}

export function isSlackEntrypointMessageId(
  messageId: string | undefined,
): boolean {
  return messageId?.startsWith(SLACK_MESSAGE_PREFIX) === true;
}

export function configuredCentralT3Client(
  environment: NodeJS.ProcessEnv = process.env,
): T3Client | null {
  const baseUrl =
    environment.COMPADRE_T3_CENTRAL_URL?.trim() ||
    environment.COMPADRE_T3_HOSTED_APP_URL?.trim();
  const accessToken = environment.COMPADRE_T3_CENTRAL_TOKEN?.trim();
  if (!baseUrl || !accessToken) return null;
  return new T3Client(baseUrl, accessToken);
}

function selectedProjectId(
  projects: ReadonlyArray<{ id: string }>,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.COMPADRE_T3_CENTRAL_PROJECT_ID?.trim();
  if (configured) {
    if (!projects.some((project) => project.id === configured)) {
      throw new Error(
        `Configured central T3 project ${configured} was not found.`,
      );
    }
    return configured;
  }
  const project = projects[0];
  if (!project) {
    throw new Error(
      "The central T3 environment has no project for Slack threads.",
    );
  }
  return project.id;
}

export async function runCentralT3Conversation(input: {
  client: CentralT3ConversationClient;
  canonicalThreadId: string;
  title: string;
  prompt: string;
  displayText?: string;
  attribution?: T3MessageAttribution;
  inputFiles?: ReadonlyArray<T3InputFile>;
  profile?: AgentProfile;
  modelSelection?: T3ModelSelection;
  entrypoint?: "slack" | "api";
  loadInitialContext?: () => Promise<string>;
  loadTurnContext?: () => Promise<string>;
  loadInitialInputFiles?: () => Promise<ReadonlyArray<T3InputFile>>;
  loadTurnInputFiles?: () => Promise<ReadonlyArray<T3InputFile>>;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  idFactory?: () => string;
  onPrepared?(prepared: CentralT3ConversationPrepared): void | Promise<void>;
  onDispatched?(
    prepared: CentralT3ConversationPrepared,
    dispatch: T3TurnDispatch,
  ): void | Promise<void>;
  onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  onTextDelta?(text: string): void | Promise<void>;
  onToolStart?(name: string): void | Promise<void>;
}): Promise<CentralT3ConversationResult> {
  const environment = input.environment ?? process.env;
  const idFactory = input.idFactory ?? crypto.randomUUID;
  const span = trace.getTracer("compadre.t3.central").startSpan(
    "compadre.t3.conversation",
    {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": input.canonicalThreadId,
        "compadre.entrypoint": input.entrypoint ?? "slack",
        "dd_llmobs_enabled": false,
      },
    },
  );
  const startedAt = Date.now();
  try {
  const [descriptor, orchestration] = await Promise.all([
    input.client.environmentDescriptor(input.signal),
    input.client.snapshot(input.signal),
  ]);
  const t3ThreadId = centralT3ThreadId(input.canonicalThreadId);
  const existing = orchestration.threads.find(
    (thread) => thread.id === t3ThreadId,
  );
  const projectId =
    existing?.projectId ??
    selectedProjectId(orchestration.projects, environment);
  const requestedSelection =
    input.modelSelection ?? t3ModelSelectionForProfile(input.profile);
  // A T3 thread owns one provider session and one Modal environment. A Slack
  // continuation therefore follows the selection already visible in the web
  // UI instead of silently trying to move the conversation to another harness.
  const modelSelection = existing?.modelSelection ?? requestedSelection;
  const prepared: CentralT3ConversationPrepared = {
    canonicalThreadId: input.canonicalThreadId,
    t3ThreadId,
    environmentId: descriptor.environmentId,
    projectId,
    detailsUrl: centralT3DetailsUrl({
      baseUrl: input.client.baseUrl,
      environmentId: descriptor.environmentId,
      threadId: t3ThreadId,
    }),
    modelSelection,
    resumed: existing !== undefined,
  };
  span.setAttributes({
    "t3.environment_id": prepared.environmentId,
    "t3.thread_id": prepared.t3ThreadId,
    "t3.project_id": prepared.projectId,
    "t3.thread_resumed": prepared.resumed,
    "gen_ai.request.model": prepared.modelSelection.model,
    "agent.provider": prepared.modelSelection.instanceId,
    "compadre.prepare_ms": Date.now() - startedAt,
  });
  span.addEvent("t3.conversation.prepared");
  await input.onPrepared?.(prepared);

  const promptContext = input.loadTurnContext
    ? (await input.loadTurnContext()).trim()
    : existing
      ? ""
      : (await input.loadInitialContext?.())?.trim() ?? "";
  const providerPrompt = prependConversationContext(
    promptContext,
    input.prompt,
  );
  const inputFiles = input.loadTurnInputFiles
    ? await input.loadTurnInputFiles()
    : existing
      ? input.inputFiles
      : (await input.loadInitialInputFiles?.()) ?? input.inputFiles;

  const messageId = `${input.entrypoint === "api" ? API_MESSAGE_PREFIX : SLACK_MESSAGE_PREFIX}${idFactory()}`;
  const dispatch = existing
    ? await input.client.startTurn({
        threadId: t3ThreadId,
        messageId,
        text: providerPrompt,
        displayText: input.displayText,
        attribution: input.attribution,
        inputFiles,
        modelSelection,
        signal: input.signal,
      })
    : await input.client.startNewThread({
        threadId: t3ThreadId,
        messageId,
        projectId,
        title: input.title,
        text: providerPrompt,
        displayText: input.displayText,
        attribution: input.attribution,
        inputFiles,
        modelSelection,
        signal: input.signal,
      });
  await input.onDispatched?.(prepared, dispatch);
  span.setAttribute("compadre.dispatch_ms", Date.now() - startedAt);
  span.addEvent("t3.turn.dispatched", {
    "t3.dispatch_sequence": dispatch.sequence,
    "t3.message_id": dispatch.messageId,
  });

  const deliveredToolStarts = new Set<string>();
  let sawSnapshot = false;
  const deliverSnapshot = async (snapshot: T3ThreadSnapshot) => {
    if (!sawSnapshot) {
      sawSnapshot = true;
      span.setAttribute("compadre.first_snapshot_ms", Date.now() - startedAt);
      span.addEvent("t3.turn.first_snapshot");
    }
    await input.onSnapshot?.(snapshot);
    const requestedTurnId = snapshot.thread.messages.find(
      (message) => message.id === dispatch.messageId,
    )?.turnId;
    const rawActivities = snapshot.thread.activities;
    if (Array.isArray(rawActivities)) {
      for (const rawActivity of rawActivities) {
        const activity = record(rawActivity);
        const activityId = stringValue(activity?.id);
        const activityTurnId = stringValue(activity?.turnId);
        const activityCreatedAt = stringValue(activity?.createdAt);
        const belongsToRequestedTurn = requestedTurnId
          ? activityTurnId === requestedTurnId ||
            (activityTurnId === undefined &&
              activityCreatedAt !== undefined &&
              Date.parse(activityCreatedAt) >= Date.parse(dispatch.createdAt))
          : activityCreatedAt !== undefined &&
            Date.parse(activityCreatedAt) >= Date.parse(dispatch.createdAt);
        if (
          !activity ||
          !activityId ||
          deliveredToolStarts.has(activityId) ||
          activity.kind !== "tool.started" ||
          !belongsToRequestedTurn
        ) {
          continue;
        }
        deliveredToolStarts.add(activityId);
        await input.onToolStart?.(toolStatusName(activity));
      }
    }
  };
  const snapshot = await input.client.waitForTurnTerminal({
    threadId: t3ThreadId,
    minimumSequence: dispatch.sequence,
    messageId: dispatch.messageId,
    requestedAt: dispatch.createdAt,
    timeoutMs: CENTRAL_T3_TIMEOUT_MS,
    absoluteTimeoutMs: CENTRAL_T3_ABSOLUTE_TIMEOUT_MS,
    signal: input.signal,
    onSnapshot: deliverSnapshot,
  });
  await deliverSnapshot(snapshot);
  span.setAttribute("compadre.terminal_ms", Date.now() - startedAt);
  span.setAttribute(
    "t3.turn.state",
    snapshot.thread.latestTurn?.state ?? "missing",
  );
  span.addEvent("t3.turn.terminal");

  const state = snapshot.thread.latestTurn?.state;
  if (state === "error") {
    throw new Error(
      snapshot.thread.session?.lastError || "The central T3 run failed.",
    );
  }
  if (state === "interrupted")
    throw new Error("The central T3 run was interrupted.");
  const incompleteReason = incompleteProviderStopReason(
    snapshot,
    snapshot.thread.latestTurn?.turnId,
  );
  if (incompleteReason) {
    throw new Error(
      `The central T3 run stopped before completing (${incompleteReason}).`,
    );
  }
  const output = finalAssistantTextForDispatch(snapshot, dispatch);
  if (!output.trim()) {
    throw new Error(
      "The central T3 run completed without an assistant response.",
    );
  }
  await input.onTextDelta?.(output);
  return { ...prepared, output, dispatch, snapshot };
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.setAttribute("compadre.total_ms", Date.now() - startedAt);
    span.end();
  }
}
