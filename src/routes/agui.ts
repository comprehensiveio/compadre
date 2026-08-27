import crypto from "node:crypto";
import {
  chatParamsFromRequestBody,
  convertMessagesToModelMessages,
  type ModelMessage,
} from "@tanstack/ai";
import { Hono } from "hono";
import { CODEX_MODEL, DEFAULT_MODEL, FABLE_MODEL } from "../config.js";
import { durableRunEventsResponse } from "../durability/http.js";
import {
  apiMessageAttribution,
  startCentralT3DurableRun,
} from "../services/central-t3-run.js";
import {
  isAgentProfile,
  isAgentProvider,
  providerForAgentProfile,
  type AgentProfile,
} from "../tanstack/protocol.js";
import type { T3Client, T3ModelSelection } from "../t3/client.js";
import {
  centralT3ThreadId,
  configuredCentralT3Client,
  type CentralT3ConversationClient,
} from "../t3/central-conversation.js";
import {
  NATIVE_T3_PROTOCOL_HEADER,
  NATIVE_T3_PROTOCOL_VERSION,
} from "../t3/agui-protocol.js";
import { getConfiguredNativeT3RunCoordinator } from "../t3/runtime.js";
import type { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import { requireCompadreApiKey } from "./auth.js";

export interface AguiRouteDependencies {
  enabled(): boolean;
  getClient():
    | (CentralT3ConversationClient &
        Pick<T3Client, "interruptTurn" | "threadSnapshot">)
    | null;
  getRunCoordinator(): Promise<NativeT3RunCoordinator | null>;
  createId(): string;
}

const defaultDependencies: AguiRouteDependencies = {
  enabled: () =>
    process.env.COMPADRE_T3_API_ENABLED === "true" ||
    process.env.COMPADRE_TANSTACK_AI_ENABLED === "true",
  getClient: configuredCentralT3Client,
  getRunCoordinator: getConfiguredNativeT3RunCoordinator,
  createId: crypto.randomUUID,
};

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

function nonEmptyString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function providerOptions(value: unknown): NonNullable<T3ModelSelection["options"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id, 100);
    const optionValue = record.value;
    if (
      !id ||
      (typeof optionValue !== "string" && typeof optionValue !== "boolean")
    ) {
      return [];
    }
    return [{ id, value: optionValue }];
  }).slice(0, 20);
}

function selectedModel(input: {
  profile?: AgentProfile;
  provider?: "claude-code" | "codex";
  model?: unknown;
  options?: unknown;
}): T3ModelSelection {
  const provider = input.profile
    ? providerForAgentProfile(input.profile)
    : input.provider ?? "codex";
  const requestedModel = nonEmptyString(input.model, 200);
  const options = providerOptions(input.options);
  if (provider === "codex") {
    return {
      instanceId: "codex",
      model: requestedModel ?? CODEX_MODEL,
      ...(options.length > 0 ? { options } : {}),
    };
  }
  return {
    instanceId: "claudeAgent",
    model:
      requestedModel ?? (input.profile === "fable" ? FABLE_MODEL : DEFAULT_MODEL),
    ...(options.length > 0 ? { options } : {}),
  };
}

function emptyHydration() {
  return { messages: [], activeRun: null, interrupts: null };
}

export function createAguiRoutes(
  dependencies: AguiRouteDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.get("/ag-ui", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const threadId = c.req.query("threadId")?.trim();
    if (!threadId) return c.json(emptyHydration());
    const client = dependencies.getClient();
    const coordinator = await dependencies.getRunCoordinator();
    if (!client || !coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    try {
      const [snapshot, active] = await Promise.all([
        client.threadSnapshot(centralT3ThreadId(threadId), c.req.raw.signal),
        coordinator.activeRun(threadId),
      ]);
      return c.json({
        messages: snapshot.thread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: [{ type: "text", content: message.text }],
        })),
        activeRun: active ? { runId: active.runId } : null,
        interrupts: null,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status?: unknown }).status === 404
      ) {
        return c.json(emptyHydration());
      }
      throw error;
    }
  });

  routes.post("/ag-ui", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;

    let params;
    try {
      params = await chatParamsFromRequestBody(await c.req.json());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[ag-ui] rejected invalid protocol request: ${detail}`);
      return c.json({ error: "invalid AG-UI body" }, 400);
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
    const text = await latestUserMessage(params.messages);
    if (!text) return c.json({ error: "a text user message is required" }, 400);
    const client = dependencies.getClient();
    const coordinator = await dependencies.getRunCoordinator();
    if (!client || !coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }

    const runId = params.runId || dependencies.createId();
    const threadId = params.threadId || `ag-ui:${dependencies.createId()}`;
    await startCentralT3DurableRun({
      coordinator,
      client,
      runId,
      threadId,
      title:
        nonEmptyString(params.forwardedProps.title, 200) ?? "Compadre API thread",
      prompt: text,
      displayText: text,
      attribution: apiMessageAttribution(),
      profile: requestedProfile,
      modelSelection: selectedModel({
        profile: requestedProfile,
        provider: requestedProvider,
        model: params.forwardedProps.model,
        options: params.forwardedProps.modelOptions,
      }),
    });
    return durableRunEventsResponse(
      coordinator.stream(runId),
      c.req.raw,
      { [NATIVE_T3_PROTOCOL_HEADER]: String(NATIVE_T3_PROTOCOL_VERSION) },
      "-1",
    );
  });

  routes.get("/ag-ui/runs/:runId/events", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const runId = c.req.param("runId");
    if (!(await coordinator.run(runId))) {
      return c.json({ error: "run not found" }, 404);
    }
    return durableRunEventsResponse(
      coordinator.stream(runId),
      c.req.raw,
      { [NATIVE_T3_PROTOCOL_HEADER]: String(NATIVE_T3_PROTOCOL_VERSION) },
    );
  });

  routes.post("/ag-ui/runs/:runId/cancel", async (c) => {
    if (!dependencies.enabled()) return c.notFound();
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json({ error: "central T3 durability is not configured" }, 503);
    }
    const result = await coordinator.cancel(c.req.param("runId"));
    if (!result.found) return c.json({ error: "run not found" }, 404);
    return c.json({ ok: true, ...result }, result.requested ? 202 : 200);
  });

  return routes;
}

export const aguiRoutes = createAguiRoutes();
