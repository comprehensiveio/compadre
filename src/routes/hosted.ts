import crypto from "node:crypto";
import {
  chatParamsFromRequestBody,
  convertMessagesToModelMessages,
  isTerminalRunStatus,
  resumeServerSentEventsResponse,
  type ModelMessage,
  type StreamDurability,
} from "@tanstack/ai";
import { reconstructChat } from "@tanstack/ai-persistence";
import { Hono } from "hono";
import {
  ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS,
  failOpenDurableRun,
  getConfiguredAgentRunDurability,
  type AgentRunDurability,
} from "../durability/runtime.js";
import {
  getConfiguredThreadPersistence,
  type ThreadPersistenceRuntime,
} from "../persistence/runtime.js";
import { configuredAgentProvider } from "../conversation.js";
import { startHostedSlackDelivery } from "../services/hosted-slack-delivery.js";
import {
  HostedThreadBindingStore,
  type HostedSlackBinding,
} from "../services/hosted-thread-bindings.js";
import {
  createConfiguredWorkflowRunLauncher,
  type WorkflowRunLauncher,
} from "../services/workflow-run-launcher.js";
import {
  isAgentProfile,
  isAgentProvider,
  providerForAgentProfile,
  type AgentProvider,
} from "../tanstack/protocol.js";
import { requireCompadreApiKey } from "./auth.js";

export interface HostedSlackDeliveryStart {
  binding: HostedSlackBinding;
  durability: AgentRunDurability;
  runId: string;
  provider: AgentProvider;
  userMessage: string;
}

export interface HostedRoutesDependencies {
  enabled(): boolean;
  getDurability(): Promise<AgentRunDurability | null>;
  getThreadPersistence(): Promise<ThreadPersistenceRuntime | null>;
  getLauncher(): WorkflowRunLauncher;
  getSlackBinding(threadId: string): Promise<HostedSlackBinding | null>;
  bindSlack(threadId: string, binding: HostedSlackBinding): Promise<void>;
  startSlackDelivery(input: HostedSlackDeliveryStart): void;
  createId(): string;
}

let configuredLauncher: WorkflowRunLauncher | undefined;
const defaultDependencies: HostedRoutesDependencies = {
  enabled: () => process.env.COMPADRE_HOSTED_T3_ENABLED === "true",
  getDurability: getConfiguredAgentRunDurability,
  getThreadPersistence: getConfiguredThreadPersistence,
  getLauncher: () =>
    (configuredLauncher ??= createConfiguredWorkflowRunLauncher()),
  async getSlackBinding(threadId) {
    const runtime = await getConfiguredThreadPersistence();
    if (!runtime) return null;
    return new HostedThreadBindingStore(
      runtime.persistence.stores.metadata,
    ).slack(threadId);
  },
  async bindSlack(threadId, binding) {
    const runtime = await getConfiguredThreadPersistence();
    if (!runtime) throw new Error("thread persistence requires durability");
    await new HostedThreadBindingStore(
      runtime.persistence.stores.metadata,
    ).bindSlack(threadId, binding);
  },
  startSlackDelivery(input) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) return;
    startHostedSlackDelivery({ ...input, botToken });
  },
  createId: () => crypto.randomUUID(),
};

function resumableAdapter(
  stream: StreamDurability<string>,
  request: Request,
): StreamDurability<string> {
  const offset =
    request.headers.get("Last-Event-ID") ||
    new URL(request.url).searchParams.get("offset");
  return {
    resumeFrom: () => offset ?? "-1",
    append: (chunks) => stream.append(chunks),
    read: (streamOffset, signal) => stream.read(streamOffset, signal),
    close: () => stream.close(),
    snapshot: () => stream.snapshot(),
  };
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

function latestUserMessage(messages: unknown[]): string | null {
  const normalized = convertMessagesToModelMessages(messages as never);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const text = textContent(normalized[index]);
    if (text) return text;
  }
  return null;
}

export function createHostedRoutes(
  dependencies: HostedRoutesDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.get("/hosted/chat", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const runId = c.req.query("runId");
    if (runId) {
      const durability = await dependencies.getDurability();
      if (!durability) {
        return c.json({ error: "agent run durability is not configured" }, 503);
      }
      const run = await durability.runs.get(runId);
      if (!run) return c.json({ error: "run not found" }, 404);
      const stream = durability.stream(
        runId,
        isTerminalRunStatus(run.status)
          ? undefined
          : { firstChunkDeadlineMs: ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS },
      );
      return resumeServerSentEventsResponse({
        adapter: resumableAdapter(stream, c.req.raw),
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const runtime = await dependencies.getThreadPersistence();
    if (!runtime) {
      return c.json({ error: "thread persistence requires durability" }, 503);
    }
    return reconstructChat(runtime.persistence, c.req.raw, {
      // The experiment remains behind the shared key. A public deployment must
      // replace this with user and thread ownership checks.
      authorize: () => true,
    });
  });

  routes.post("/hosted/threads/:threadId/slack", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const value = body as Partial<HostedSlackBinding> | null;
    if (
      !value ||
      typeof value.channelId !== "string" ||
      !value.channelId.trim() ||
      typeof value.threadTs !== "string" ||
      !value.threadTs.trim()
    ) {
      return c.json({ error: "channelId and threadTs are required" }, 400);
    }
    const binding: HostedSlackBinding = {
      channelId: value.channelId.trim(),
      threadTs: value.threadTs.trim(),
      ...(typeof value.recipientUserId === "string"
        ? { recipientUserId: value.recipientUserId }
        : {}),
      ...(typeof value.recipientTeamId === "string"
        ? { recipientTeamId: value.recipientTeamId }
        : {}),
    };
    await dependencies.bindSlack(c.req.param("threadId"), binding);
    return c.json({ ok: true, binding });
  });

  routes.post("/hosted/chat", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    let params;
    try {
      params = await chatParamsFromRequestBody(body);
    } catch (error) {
      return c.json(
        {
          error: "invalid hosted chat body",
          detail: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    const userMessage = latestUserMessage(params.messages);
    if (!userMessage) {
      return c.json({ error: "a text user message is required" }, 400);
    }

    const requestedProvider = params.forwardedProps.provider;
    if (requestedProvider !== undefined && !isAgentProvider(requestedProvider)) {
      return c.json(
        { error: "forwardedProps.provider must be 'claude-code' or 'codex'" },
        400,
      );
    }
    const requestedProfile = params.forwardedProps.profile;
    if (requestedProfile !== undefined && !isAgentProfile(requestedProfile)) {
      return c.json(
        {
          error:
            "forwardedProps.profile must be 'claude-code', 'codex', or 'fable'",
        },
        400,
      );
    }

    const durability = await dependencies.getDurability();
    if (!durability) {
      return c.json({ error: "agent run durability is not configured" }, 503);
    }
    const runId = params.runId || dependencies.createId();
    const threadId = params.threadId;
    const binding = await dependencies.getSlackBinding(threadId);
    const provider = requestedProfile
      ? providerForAgentProfile(requestedProfile)
      : requestedProvider ?? configuredAgentProvider();
    const stream = durability.stream(runId, {
      firstChunkDeadlineMs: ACTIVE_RUN_FIRST_CHUNK_DEADLINE_MS,
    });
    await durability.runs.createOrResume({
      runId,
      threadId,
      startedAt: Date.now(),
    });

    const launcher = dependencies.getLauncher();
    let started: Awaited<ReturnType<WorkflowRunLauncher["start"]>>;
    try {
      started = await launcher.start({
        runId,
        threadId,
        prompt: userMessage,
        transcriptUserMessage: userMessage,
        provider: isAgentProvider(requestedProvider)
          ? requestedProvider
          : undefined,
        profile: isAgentProfile(requestedProfile) ? requestedProfile : undefined,
        responseMode: binding ? "slack-streaming" : "default",
        persistThread: true,
      });
    } catch (error) {
      await failOpenDurableRun(durability, runId, error).catch(
        (finalizationError) =>
          console.error("[hosted] failure finalization failed", {
            runId,
            error: finalizationError,
          }),
      );
      throw error;
    }

    if (launcher.wait) {
      void launcher.wait(started.taskRunId).catch(async (error) => {
        await failOpenDurableRun(durability, runId, error).catch(
          (finalizationError) =>
            console.error("[hosted] failure finalization failed", {
              runId,
              error: finalizationError,
            }),
        );
      });
    }
    if (binding) {
      dependencies.startSlackDelivery({
        binding,
        durability,
        runId,
        provider,
        userMessage,
      });
    }

    return resumeServerSentEventsResponse({
      adapter: resumableAdapter(stream, c.req.raw),
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return routes;
}

export const hostedRoutes = createHostedRoutes();
