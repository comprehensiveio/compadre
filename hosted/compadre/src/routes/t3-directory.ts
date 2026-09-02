import crypto from "node:crypto";
import {
  chatParamsFromRequestBody,
  convertMessagesToModelMessages,
  type ModelMessage,
} from "@tanstack/ai";
import { Hono, type Context, type Handler } from "hono";
import type { T3ThreadBinding } from "../services/t3-thread-bindings.js";
import type {
  T3ModelSelection,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "../t3/client.js";
import {
  T3Gateway,
  type T3GatewayTurn,
} from "../t3/gateway.js";
import {
  getConfiguredNativeT3RunCoordinator,
  getConfiguredNativeT3RunService,
  getConfiguredT3ArtifactStore,
  getConfiguredT3Gateway,
} from "../t3/runtime.js";
import type { NativeT3RunService } from "../t3/run-service.js";
import type { NativeT3RunRequest } from "../t3/run-request-store.js";
import { requireCompadreApiKey } from "./auth.js";
import {
  NATIVE_T3_PROTOCOL_HEADER,
  NATIVE_T3_PROTOCOL_VERSION,
} from "../t3/agui-protocol.js";
import { isAgentProvider } from "../tanstack/protocol.js";
import { durableRunEventsResponse } from "../durability/http.js";
import { ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS } from "../durability/runtime.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import {
  HostedThreadBindingStore,
  type HostedSlackBinding,
} from "../services/hosted-thread-bindings.js";
import { finalAssistantTextForDispatch } from "../services/t3-slack-conversation.js";
import {
  centralT3DetailsUrl,
  isSlackEntrypointMessageId,
} from "../t3/central-conversation.js";
import type { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import { inputFilesSchema, type InputFile } from "../services/input-files.js";
import type { T3ArtifactStore } from "../t3/artifact-store.js";
import type { T3OutputArtifact } from "../t3/output-artifacts.js";

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 100_000;
const TERMINAL_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const TEXT_GENERATION_TIMEOUT_MS = 165_000;
const OUTPUT_ARTIFACT_INSTRUCTIONS = [
  "When you create a file for the user, write the final downloadable copy under /tmp/agent-outputs.",
  "Use a descriptive filename and keep temporary/intermediate files elsewhere.",
].join(" ");

interface T3DirectoryGateway {
  list(): Promise<T3ThreadBinding[]>;
  generateText?(input: {
    prompt: string;
    modelSelection: T3ModelSelection;
    inputFiles?: ReadonlyArray<InputFile>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ dispatch: T3TurnDispatch; snapshot: T3ThreadSnapshot }>;
  send(input: {
    canonicalThreadId: string;
    title: string;
    text: string;
    modelSelection: T3ModelSelection;
    signal?: AbortSignal;
  }): Promise<T3GatewayTurn>;
  snapshot(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{
    binding: T3ThreadBinding;
    snapshot: T3ThreadSnapshot;
    source: "central" | "worker";
  } | null>;
  open(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<{ binding: T3ThreadBinding; pairingUrl: string } | null>;
  cancel(input: {
    canonicalThreadId: string;
    providerInstanceId: string;
    signal?: AbortSignal;
  }): Promise<number | null>;
  waitForTerminal(input: {
    turn: T3GatewayTurn;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?(snapshot: T3ThreadSnapshot): void | Promise<void>;
  }): Promise<T3ThreadSnapshot>;
  markActiveRun?(canonicalThreadId: string, runId: string): Promise<void>;
  clearActiveRun?(canonicalThreadId: string, runId: string): Promise<void>;
  collectOutputArtifacts?(
    turn: T3GatewayTurn,
    publish: (artifact: T3OutputArtifact) => Promise<void>,
  ): Promise<{ published: Array<{ path: string; digest: string }>; failures: string[] }>;
}

export interface T3DirectoryRoutesDependencies {
  enabled(): boolean;
  getGateway(): Promise<T3DirectoryGateway | null>;
  getRunCoordinator?(): Promise<NativeT3RunCoordinator | null>;
  getRunService?(): Promise<NativeT3RunService | null>;
  getArtifactStore?(): Promise<T3ArtifactStore | null>;
  createId(): string;
  watchTurn(gateway: T3DirectoryGateway, turn: T3GatewayTurn): void;
  getSlackBinding?(threadId: string): Promise<HostedSlackBinding | null>;
}

const defaultDependencies: T3DirectoryRoutesDependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  getGateway: getConfiguredT3Gateway,
  getRunCoordinator: getConfiguredNativeT3RunCoordinator,
  getRunService: getConfiguredNativeT3RunService,
  getArtifactStore: getConfiguredT3ArtifactStore,
  createId: crypto.randomUUID,
  watchTurn(gateway, turn) {
    void gateway
      .waitForTerminal({ turn, timeoutMs: TERMINAL_WAIT_TIMEOUT_MS })
      .catch((error) => {
        console.error(
          `[t3-directory] terminal watch failed thread=${turn.binding.canonicalThreadId} provider=${turn.binding.providerInstanceId} error=${error instanceof Error ? error.name : "UnknownError"}`,
        );
      });
  },
  async getSlackBinding(threadId) {
    const runtime = await getConfiguredThreadPersistence();
    if (!runtime) return null;
    return new HostedThreadBindingStore(
      runtime.persistence.stores.metadata,
    ).slack(threadId);
  },
};

function publicBinding(binding: T3ThreadBinding) {
  return {
    canonicalThreadId: binding.canonicalThreadId,
    providerInstanceId: binding.providerInstanceId,
    t3ThreadId: binding.t3ThreadId,
    title: binding.title ?? "Untitled thread",
    modelSelection: binding.modelSelection,
    status: binding.status ?? "ready",
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function nonEmptyString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) return null;
  return normalized;
}

function modelSelection(value: unknown): T3ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const instanceId = nonEmptyString(record.instanceId, 100);
  const model = nonEmptyString(record.model, 200);
  if (!instanceId || !model) return null;
  if (instanceId !== "codex" && instanceId !== "claudeAgent") return null;
  const options = providerOptions(record.options);
  return { instanceId, model, ...(options.length > 0 ? { options } : {}) };
}

function providerOptions(value: unknown): NonNullable<T3ModelSelection["options"]> {
  if (!Array.isArray(value)) return [];
  const options: Array<NonNullable<T3ModelSelection["options"]>[number]> = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id, 100);
    const optionValue = record.value;
    if (!id || (typeof optionValue !== "string" && typeof optionValue !== "boolean")) continue;
    if (typeof optionValue === "string") {
      const normalized = nonEmptyString(optionValue, 200);
      if (normalized) options.push({ id, value: normalized });
      continue;
    }
    options.push({ id, value: optionValue });
  }
  return options;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function routeIdentity(canonicalThreadId: string, providerInstanceId: string) {
  return { canonicalThreadId, providerInstanceId };
}

function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`Missing route parameter ${name}`);
  return value;
}

function textContent(message: ModelMessage | undefined): string | null {
  if (!message || message.role !== "user") return null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n")
    .trim();
  return text || null;
}

async function latestUserMessage(messages: unknown): Promise<string | null> {
  const converted = await convertMessagesToModelMessages(messages as never);
  for (let index = converted.length - 1; index >= 0; index -= 1) {
    const message = converted[index];
    if (message?.role === "user") return textContent(message);
  }
  return null;
}

function latestUserMessageId(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role === "user" && typeof record.id === "string") {
      return record.id;
    }
  }
  return undefined;
}

interface TrustedRequesterContext {
  userId: string;
  displayName: string;
  origin: "web" | "slack" | "api";
  slack?: {
    workspaceId?: string;
    userId?: string;
    channelId?: string;
    messageTs?: string;
    threadTs?: string;
  };
}

function trustedRequesterContext(value: unknown): TrustedRequesterContext | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const userId = nonEmptyString(candidate.userId, 200);
  const displayName = nonEmptyString(candidate.displayName, 300);
  const origin = candidate.origin;
  if (
    !userId ||
    !displayName ||
    (origin !== "web" && origin !== "slack" && origin !== "api")
  ) {
    return null;
  }
  const slackRecord =
    candidate.slack && typeof candidate.slack === "object"
      ? (candidate.slack as Record<string, unknown>)
      : null;
  const slack = slackRecord
    ? {
        workspaceId:
          nonEmptyString(slackRecord.workspaceId, 200) ?? undefined,
        userId: nonEmptyString(slackRecord.userId, 200) ?? undefined,
        channelId: nonEmptyString(slackRecord.channelId, 200) ?? undefined,
        messageTs: nonEmptyString(slackRecord.messageTs, 200) ?? undefined,
        threadTs: nonEmptyString(slackRecord.threadTs, 200) ?? undefined,
      }
    : undefined;
  return {
    userId,
    displayName,
    origin,
    ...(slack ? { slack } : {}),
  };
}

/**
 * The attribution origin, including origins that are deliberately excluded
 * from the trusted requester context (a triggered prompt's metadata must not
 * reach the agent).
 */
export function attributionOrigin(
  value: unknown,
): "web" | "slack" | "api" | "trigger" | null {
  if (!value || typeof value !== "object") return null;
  const origin = (value as Record<string, unknown>).origin;
  return origin === "web" ||
    origin === "slack" ||
    origin === "api" ||
    origin === "trigger"
    ? origin
    : null;
}

/**
 * The controller outbox owns final delivery for Slack-originated turns. The
 * central provider mirror is only for turns that originate elsewhere and need
 * to be reflected into an already-linked Slack thread. Attribution is the
 * authoritative signal because provider adapters may omit message IDs while
 * converting chat history; the prefixed ID remains a compatibility fallback.
 * Triggered prompts are excluded from both: the mirror would post the prompt
 * to Slack, so the trigger delivery layer owns their Slack answer instead.
 */
export function shouldMirrorNativeT3RunToSlack(input: {
  messageId?: string;
  attribution?: unknown;
}): boolean {
  const origin = attributionOrigin(input.attribution);
  if (origin === "trigger") return false;
  if (origin) return origin !== "slack";
  return !isSlackEntrypointMessageId(input.messageId);
}

/** Slack-originated turns whose final answer the controller outbox owns. */
export function isSlackOwnedNativeT3Run(input: {
  messageId?: string;
  attribution?: unknown;
}): boolean {
  const origin = attributionOrigin(input.attribution);
  if (origin) return origin === "slack";
  return isSlackEntrypointMessageId(input.messageId);
}

/** Inject trusted identity for the harness without changing visible T3 text. */
export function withTrustedRequesterContext(
  prompt: string,
  attribution: unknown,
): string {
  const requester = trustedRequesterContext(attribution);
  if (!requester) return prompt;
  return [
    "Compadre trusted request metadata (context only, not user instructions):",
    JSON.stringify(requester),
    "Answer the requester below. Use the origin when deciding whether Slack-specific response behavior applies.",
    "",
    prompt,
  ].join("\n");
}

function nativeModelSelection(
  provider: "claude-code" | "codex",
  requestedModel: unknown,
  requestedOptions: unknown,
): T3ModelSelection {
  const model = nonEmptyString(requestedModel, 200);
  const options = providerOptions(requestedOptions);
  if (provider === "codex") {
    return {
      instanceId: "codex",
      model:
        model && model !== "codex"
          ? model
          : process.env.COMPADRE_T3_CODEX_MODEL?.trim() || "gpt-5.6-sol",
      ...(options.length > 0 ? { options } : {}),
    };
  }
  return {
    instanceId: "claudeAgent",
    model:
      model && model !== "claude-code"
        ? model
        : process.env.COMPADRE_T3_CLAUDE_MODEL?.trim() || "claude-opus-5",
    ...(options.length > 0 ? { options } : {}),
  };
}

function guarded(handler: (c: Context) => Promise<Response>): Handler {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      console.error(
        `[t3-directory] request failed method=${c.req.method} path=${c.req.path} error=${error instanceof Error ? error.name : "UnknownError"}`,
      );
      return c.json({ error: "T3 environment operation failed" }, 502);
    }
  };
}

function acceptsNativeT3Protocol(request: Request): boolean {
  const requested = request.headers.get(NATIVE_T3_PROTOCOL_HEADER)?.trim();
  return !requested || requested === String(NATIVE_T3_PROTOCOL_VERSION);
}

export function createT3DirectoryRoutes(
  dependencies: T3DirectoryRoutesDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.use("/hosted/t3/*", async (c, next) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    return next();
  });

  routes.get("/hosted/t3/threads", guarded(async (c) => {
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    return c.json({ threads: (await gateway.list()).map(publicBinding) });
  }));

  routes.get("/hosted/t3/artifacts", guarded(async (c) => {
    const runId = c.req.query("runId")?.trim() ?? "";
    const artifactId = c.req.query("artifactId")?.trim() ?? "";
    if (!runId || runId.length > 200 || !/^[a-f0-9]{64}$/u.test(artifactId)) {
      return c.json({ error: "invalid T3 artifact reference" }, 400);
    }
    const artifacts = await dependencies.getArtifactStore?.();
    if (!artifacts) return c.json({ error: "T3 artifact storage is unavailable" }, 503);
    const artifact = await artifacts.read(runId, artifactId);
    if (!artifact) return c.json({ error: "T3 artifact not found" }, 404);
    return new Response(Uint8Array.from(artifact.bytes).buffer, {
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-length": String(artifact.bytes.byteLength),
        "content-type": artifact.metadata.mimetype,
        etag: `"sha256-${artifact.metadata.artifactId}"`,
      },
    });
  }));

  routes.post("/hosted/t3/threads", guarded(async (c) => {
    const body = await requestBody(c.req.raw);
    const title = nonEmptyString(body?.title, MAX_TITLE_LENGTH);
    const text = nonEmptyString(body?.text, MAX_MESSAGE_LENGTH);
    const selection = modelSelection(body?.modelSelection);
    const requestedId = nonEmptyString(body?.canonicalThreadId, 200);
    if (!title || !text || !selection) {
      return c.json(
        { error: "title, text, and a supported modelSelection are required" },
        400,
      );
    }
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    const turn = await gateway.send({
      canonicalThreadId: requestedId ?? dependencies.createId(),
      title,
      text,
      modelSelection: selection,
      signal: c.req.raw.signal,
    });
    dependencies.watchTurn(gateway, turn);
    return c.json(
      { thread: publicBinding(turn.binding), dispatch: turn.dispatch },
      202,
    );
  }));

  routes.post("/hosted/t3/text-generation", guarded(async (c) => {
    const body = await requestBody(c.req.raw);
    const prompt = nonEmptyString(body?.prompt, MAX_MESSAGE_LENGTH);
    const provider = body?.provider;
    if (!prompt || !isAgentProvider(provider)) {
      return c.json(
        { error: "prompt and a supported provider are required" },
        400,
      );
    }
    const gateway = await dependencies.getGateway();
    if (!gateway?.generateText) {
      return c.json({ error: "native T3 text generation is unavailable" }, 503);
    }
    const generated = await gateway.generateText({
      prompt,
      modelSelection: nativeModelSelection(
        provider,
        body?.model,
        body?.modelOptions,
      ),
      timeoutMs: TEXT_GENERATION_TIMEOUT_MS,
      signal: c.req.raw.signal,
    });
    const result = finalAssistantTextForDispatch(
      generated.snapshot,
      generated.dispatch,
    );
    if (!result) {
      return c.json(
        { error: "native T3 text generation returned no assistant response" },
        502,
      );
    }
    return c.json({ result });
  }));

  routes.post("/hosted/t3/chat", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    if (!acceptsNativeT3Protocol(c.req.raw)) {
      return c.json(
        {
          error: "unsupported native T3 protocol version",
          supported: [NATIVE_T3_PROTOCOL_VERSION],
        },
        409,
      );
    }
    let params;
    try {
      params = await chatParamsFromRequestBody(await c.req.json());
    } catch (error) {
      return c.json({
        error: "invalid native T3 provider body",
        detail: error instanceof Error ? error.message : String(error),
      }, 400);
    }
    const provider = params.forwardedProps.provider;
    if (!isAgentProvider(provider)) {
      return c.json({
        error: "forwardedProps.provider must be 'claude-code' or 'codex'",
      }, 400);
    }
    const text = await latestUserMessage(params.messages);
    if (!text) return c.json({ error: "a text user message is required" }, 400);
    const gateway = await dependencies.getGateway();
    if (!gateway) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    const runService = await (
      dependencies.getRunService?.() ?? getConfiguredNativeT3RunService()
    );
    if (!runService) {
      return c.json({ error: "native T3 run durability is not configured" }, 503);
    }
    const artifactStore = await dependencies.getArtifactStore?.();
    const runId = params.runId || dependencies.createId();
    const canonicalThreadId = params.threadId || dependencies.createId();
    const selectedModel = nativeModelSelection(
      provider,
      params.forwardedProps.model,
      params.forwardedProps.modelOptions,
    );
    const parsedInputFiles = inputFilesSchema.safeParse(
      params.forwardedProps.inputFiles ?? [],
    );
    if (!parsedInputFiles.success) {
      return c.json({ error: "forwardedProps.inputFiles is invalid" }, 400);
    }
    const messageId = latestUserMessageId(params.messages);
    const forwardedProps = params.forwardedProps as typeof params.forwardedProps & {
      attribution?: unknown;
    };
    const providerText = withTrustedRequesterContext(
      text,
      forwardedProps.attribution,
    );
    const linkedSlackBinding = dependencies.getSlackBinding
      ? await dependencies.getSlackBinding(canonicalThreadId)
      : null;
    const slackOwnedDelivery = isSlackOwnedNativeT3Run({
      messageId,
      attribution: forwardedProps.attribution,
    });
    if (slackOwnedDelivery && !linkedSlackBinding) {
      return c.json(
        { error: "Slack-originated turns require a durable thread binding" },
        409,
      );
    }
    const slackBinding =
      process.env.COMPADRE_HOSTED_SLACK_DELIVERY_ENABLED !== "false" &&
      shouldMirrorNativeT3RunToSlack({
        messageId,
        attribution: forwardedProps.attribution,
      })
        ? linkedSlackBinding
        : null;
    const botToken = process.env.SLACK_BOT_TOKEN?.trim();
    const hostedAppUrl = process.env.COMPADRE_T3_HOSTED_APP_URL?.trim();
    const detailsUrl =
      slackBinding?.t3EnvironmentId && slackBinding.t3ThreadId && hostedAppUrl
        ? centralT3DetailsUrl({
            baseUrl: hostedAppUrl,
            environmentId: slackBinding.t3EnvironmentId,
            threadId: slackBinding.t3ThreadId,
          })
        : undefined;
    const runRequest: NativeT3RunRequest = {
      runId,
      canonicalThreadId,
      provider,
      title:
        nonEmptyString(params.forwardedProps.title, MAX_TITLE_LENGTH) ??
        "T3 thread",
      text: artifactStore
        ? `${providerText}\n\n${OUTPUT_ARTIFACT_INSTRUCTIONS}`
        : providerText,
      modelSelection: selectedModel,
      inputFiles: parsedInputFiles.data,
      ...(linkedSlackBinding
        ? {
            blockedSlackDestination: {
              channelId: linkedSlackBinding.channelId,
              threadTs: linkedSlackBinding.threadTs,
            },
            slackArtifactDestination: {
              channelId: linkedSlackBinding.channelId,
              threadTs: linkedSlackBinding.threadTs,
              ...(linkedSlackBinding.recipientTeamId
                ? { recipientTeamId: linkedSlackBinding.recipientTeamId }
                : {}),
            },
          }
        : {}),
      ...(slackBinding && botToken
        ? {
            slackMirror: {
              channelId: slackBinding.channelId,
              threadTs: slackBinding.threadTs,
              ...(slackBinding.recipientUserId
                ? { recipientUserId: slackBinding.recipientUserId }
                : {}),
              ...(slackBinding.recipientTeamId
                ? { recipientTeamId: slackBinding.recipientTeamId }
                : {}),
              userMessage: text,
              ...(detailsUrl ? { detailsUrl } : {}),
            },
          }
        : {}),
      collectArtifacts: Boolean(artifactStore),
      createdAt: new Date().toISOString(),
    };
    await runService.startTurn(runRequest);
    // This subscriber KNOWS the run is live (it just started it), so it may
    // wait out orchestrator scheduling before the first chunk. The Postgres
    // backend ignores the option; the memory backend would otherwise apply
    // its unknown-run fail-fast and drop the stream before RUN_STARTED.
    return durableRunEventsResponse(
      runService.stream(runId, {
        firstChunkDeadlineMs: ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS,
      }),
      c.req.raw,
      {
        [NATIVE_T3_PROTOCOL_HEADER]: String(NATIVE_T3_PROTOCOL_VERSION),
      },
      "-1",
    );
  });

  routes.get("/hosted/t3/runs/:runId/events", guarded(async (c) => {
    const runService = await (
      dependencies.getRunService?.() ?? getConfiguredNativeT3RunService()
    );
    const runCoordinator = await (
      dependencies.getRunCoordinator?.() ??
      getConfiguredNativeT3RunCoordinator()
    );
    const reader = runService ?? runCoordinator;
    if (!reader) {
      return c.json({ error: "native T3 run durability is not configured" }, 503);
    }
    const runId = routeParam(c, "runId");
    const run = await reader.run(runId);
    if (!run) return c.json({ error: "native T3 run not found", runId }, 404);
    // A replay subscriber may arrive after the run's producer disappeared.
    // The service decides whether reattachment is needed: the Temporal
    // orchestrator is a no-op (its drive activity is the sole producer), the
    // in-process orchestrator reattaches the worker turn.
    await runService?.ensureSubscriberRecovery(runId).catch((error) => {
      console.error("[native-t3-run] recovery could not start", {
        runId,
        threadId: run.threadId,
        error,
      });
    });
    return durableRunEventsResponse(reader.stream(runId), c.req.raw, {
      [NATIVE_T3_PROTOCOL_HEADER]: String(NATIVE_T3_PROTOCOL_VERSION),
    });
  }));

  routes.post("/hosted/t3/runs/:runId/cancel", guarded(async (c) => {
    const runId = routeParam(c, "runId");
    // The run service dispatches durable (workflow) cancellation; the bare
    // coordinator remains the fallback for legacy in-process producers.
    const runCanceller =
      (await (
        dependencies.getRunService?.() ?? getConfiguredNativeT3RunService()
      )) ??
      (await (
        dependencies.getRunCoordinator?.() ??
        getConfiguredNativeT3RunCoordinator()
      ));
    if (!runCanceller) {
      return c.json({ error: "native T3 run durability is not configured" }, 503);
    }
    const result = await runCanceller.cancel(runId);
    if (!result.found) {
      return c.json({ error: "native T3 run not found", runId }, 404);
    }
    return c.json({ ok: true, ...result }, result.requested ? 202 : 200);
  }));

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/messages",
    guarded(async (c) => {
      const body = await requestBody(c.req.raw);
      const text = nonEmptyString(body?.text, MAX_MESSAGE_LENGTH);
      const selection = modelSelection(body?.modelSelection);
      if (!text || !selection) {
        return c.json({ error: "text and modelSelection are required" }, 400);
      }
      const providerInstanceId = routeParam(c, "providerInstanceId");
      if (selection.instanceId !== providerInstanceId) {
        return c.json({ error: "route provider and modelSelection disagree" }, 400);
      }
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const turn = await gateway.send({
        canonicalThreadId: routeParam(c, "canonicalThreadId"),
        title: nonEmptyString(body?.title, MAX_TITLE_LENGTH) ?? "Compadre thread",
        text,
        modelSelection: selection,
        signal: c.req.raw.signal,
      });
      dependencies.watchTurn(gateway, turn);
      return c.json(
        { thread: publicBinding(turn.binding), dispatch: turn.dispatch },
        202,
      );
    }),
  );

  routes.get(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/snapshot",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const result = await gateway.snapshot({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (!result) return c.json({ error: "thread not found" }, 404);
      return c.json({
        thread: publicBinding(result.binding),
        snapshot: result.snapshot,
        source: result.source,
      });
    }),
  );

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/cancel",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const sequence = await gateway.cancel({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (sequence === null) return c.json({ error: "thread not found" }, 404);
      return c.json({ ok: true, sequence });
    }),
  );

  routes.post(
    "/hosted/t3/threads/:providerInstanceId/:canonicalThreadId/open",
    guarded(async (c) => {
      const gateway = await dependencies.getGateway();
      if (!gateway) {
        return c.json({ error: "thread persistence requires durability" }, 503);
      }
      const result = await gateway.open({
        ...routeIdentity(
          routeParam(c, "canonicalThreadId"),
          routeParam(c, "providerInstanceId"),
        ),
        signal: c.req.raw.signal,
      });
      if (!result) return c.json({ error: "thread not found" }, 404);
      return c.json({ pairingUrl: result.pairingUrl });
    }),
  );

  return routes;
}

export const t3DirectoryRoutes = createT3DirectoryRoutes();
