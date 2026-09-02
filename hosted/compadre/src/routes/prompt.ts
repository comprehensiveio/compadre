import crypto from "node:crypto";
import { Hono } from "hono";
import { isAgentProvider, type AgentProfile } from "../tanstack/protocol.js";
import {
  configuredCentralT3Client,
  runCentralT3Conversation,
  type CentralT3ConversationClient,
} from "../t3/central-conversation.js";
import type { T3Client } from "../t3/client.js";
import { getConfiguredNativeT3RunCoordinator } from "../t3/runtime.js";
import type { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import {
  apiMessageAttribution,
  startCentralT3DurableRun,
} from "../services/central-t3-run.js";
import { requireCompadreApiKey } from "./auth.js";

export interface PromptRouteDependencies {
  getClient():
    | (CentralT3ConversationClient & Pick<T3Client, "interruptTurn">)
    | null;
  getRunCoordinator(): Promise<NativeT3RunCoordinator | null>;
  createId(): string;
}

const defaultDependencies: PromptRouteDependencies = {
  getClient: configuredCentralT3Client,
  getRunCoordinator: getConfiguredNativeT3RunCoordinator,
  createId: crypto.randomUUID,
};

function selectedProfile(
  provider: "claude-code" | "codex" | undefined,
): AgentProfile | undefined {
  return provider;
}

export function createPromptRoutes(
  dependencies: PromptRouteDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.post("/prompt", async (c) => {
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      return c.json({ error: "missing 'prompt' field" }, 400);
    }
    const threadId =
      typeof body.threadId === "string" && body.threadId.trim()
        ? body.threadId.trim()
        : `api:${dependencies.createId()}`;
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : undefined;
    const requestedProvider = body.provider;
    if (requestedProvider !== undefined && !isAgentProvider(requestedProvider)) {
      return c.json({ error: "provider must be 'claude-code' or 'codex'" }, 400);
    }
    if (sessionId) {
      return c.json(
        { error: "sessionId is provider-native; use threadId" },
        400,
      );
    }
    const client = dependencies.getClient();
    if (!client) {
      return c.json({ error: "central T3 API is not configured" }, 503);
    }
    const profile = selectedProfile(requestedProvider);
    const attribution = apiMessageAttribution();
    const async = body.async === true;
    console.log(`[prompt] received (async=${async})`);

    if (async) {
      const coordinator = await dependencies.getRunCoordinator();
      if (!coordinator) {
        return c.json(
          { error: "native T3 run durability is not configured" },
          503,
        );
      }
      const runId =
        typeof body.runId === "string" && body.runId.trim()
          ? body.runId.trim()
          : dependencies.createId();
      const started = await startCentralT3DurableRun({
        coordinator,
        client,
        runId,
        threadId,
        title: prompt.slice(0, 200),
        prompt,
        displayText: prompt,
        attribution,
        profile,
      });
      return c.json(
        {
          ok: true,
          message: started.started ? "accepted" : "already accepted",
          runId,
          threadId,
          statusUrl: `/workflow-runs/${encodeURIComponent(runId)}`,
          eventsUrl: `/workflow-runs/${encodeURIComponent(runId)}/events?offset=-1`,
        },
        202,
      );
    }

    const startedAt = Date.now();
    const result = await runCentralT3Conversation({
      client,
      canonicalThreadId: threadId,
      title: prompt.slice(0, 200),
      prompt,
      displayText: prompt,
      attribution,
      profile,
      entrypoint: "api",
      signal: c.req.raw.signal,
    });
    return c.json({
      ok: true,
      result: result.output,
      sessionId: result.t3ThreadId,
      threadId,
      provider:
        result.modelSelection.instanceId === "codex"
          ? "codex"
          : "claude-code",
      model: result.modelSelection.model,
      turns: 1,
      cost: null,
      usage: null,
      duration: Date.now() - startedAt,
      detailsUrl: result.detailsUrl,
    });
  });

  return routes;
}

export const promptRoutes = createPromptRoutes();
