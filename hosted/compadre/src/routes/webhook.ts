import crypto from "node:crypto";
import { Hono } from "hono";
import {
  configuredCentralT3Client,
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

export interface WebhookRouteDependencies {
  getClient():
    | (CentralT3ConversationClient & Pick<T3Client, "interruptTurn">)
    | null;
  getRunCoordinator(): Promise<NativeT3RunCoordinator | null>;
  createId(): string;
}

const defaultDependencies: WebhookRouteDependencies = {
  getClient: configuredCentralT3Client,
  getRunCoordinator: getConfiguredNativeT3RunCoordinator,
  createId: crypto.randomUUID,
};

export function createWebhookRoutes(
  dependencies: WebhookRouteDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.post("/webhook/:source", async (c) => {
    const authError = requireCompadreApiKey(c);
    if (authError) return authError;
    const source = c.req.param("source");

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const client = dependencies.getClient();
    if (!client) {
      return c.json({ error: "central T3 API is not configured" }, 503);
    }
    const coordinator = await dependencies.getRunCoordinator();
    if (!coordinator) {
      return c.json(
        { error: "native T3 run durability is not configured" },
        503,
      );
    }

    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const runId = idempotencyKey
      ? `webhook-${crypto
          .createHash("sha256")
          .update(`${source}:${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)}`
      : dependencies.createId();
    const threadId = `webhook:${source}:${runId}`;
    const prompt = `You received a webhook event from ${source}. Analyze it and take appropriate action.

Source: ${source}
Payload:
${JSON.stringify(body, null, 2)}

Based on the source and payload, determine what action to take. For example:
- Datadog alert: investigate the issue using Datadog tools, check relevant code, post findings to Slack
- GitHub PR: review the changes, post feedback
- Linear update: check if any follow-up is needed`;

    const started = await startCentralT3DurableRun({
      coordinator,
      client,
      runId,
      threadId,
      title: `${source} webhook`,
      prompt,
      displayText: `Webhook received from ${source}`,
      attribution: apiMessageAttribution({
        userId: `webhook:${source}`,
        displayName: `${source} webhook`,
      }),
      profile: "codex",
    });
    console.log(`[webhook] accepted source=${source} run=${runId}`);
    return c.json(
      {
        ok: true,
        source,
        runId,
        threadId,
        message: started.started ? "accepted" : "already accepted",
        statusUrl: `/workflow-runs/${encodeURIComponent(runId)}`,
        eventsUrl: `/workflow-runs/${encodeURIComponent(runId)}/events?offset=-1`,
      },
      202,
    );
  });

  return routes;
}

export const webhookRoutes = createWebhookRoutes();
