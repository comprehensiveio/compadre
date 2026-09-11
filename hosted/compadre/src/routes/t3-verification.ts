import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { requireCompadreApiKey } from "./auth.js";
import { getConfiguredThreadPersistence } from "../persistence/runtime.js";
import { configuredCentralT3Client } from "../t3/central-conversation.js";
import { getConfiguredNativeThreadDelivery, getConfiguredNativeT3RunService } from "../t3/runtime.js";
import { ensureNativeThreadDeliveryWorkflow, getTemporalClient } from "../temporal/client.js";
import { inputFilesSchema } from "../services/input-files.js";
import { T3VerificationStore, verificationScenario } from "../t3/verification.js";
import type { T3Client } from "../t3/client.js";
import type { NativeThreadDelivery } from "../t3/native-events.js";
import type { NativeT3RunService } from "../t3/run-service.js";

interface VerificationResources {
  central: Pick<T3Client, "snapshot" | "createThread" | "threadSnapshot" | "startTurn" | "stopSession">;
  store: T3VerificationStore;
  delivery: Pick<NativeThreadDelivery, "get">;
  runs: Pick<NativeT3RunService, "run" | "activeRun" | "cancel">;
  requestStorage(runId: string): Promise<unknown>;
  workflow(threadId: string, epoch: number, action?: "resume" | "cancel"): Promise<unknown>;
}
interface Dependencies {
  enabled(): boolean;
  resources(): Promise<VerificationResources | null>;
}
const defaults: Dependencies = {
  enabled: () => process.env.COMPADRE_T3_DIRECTORY_ENABLED === "true",
  async resources() {
    const central = configuredCentralT3Client();
    const [persistence, delivery, runs] = await Promise.all([
      getConfiguredThreadPersistence(), getConfiguredNativeThreadDelivery(), getConfiguredNativeT3RunService(),
    ]);
    if (!central || !persistence || !delivery || !runs) return null;
    return { central, delivery, runs, store: new T3VerificationStore(persistence.persistence.stores.metadata, persistence.locks),
      async requestStorage(runId) {
        const value = await persistence.persistence.stores.metadata.get("compadre.t3.run-requests.v1", runId);
        if (!value) return null;
        const request = z.object({ inputFiles: z.array(z.object({
          objectKey: z.string().optional(), sha256: z.string().optional(), sizeBytes: z.number(), dataBase64: z.string().optional(),
        })) }).parse(value);
        return { containsInlineBytes: request.inputFiles.some((file) => file.dataBase64 !== undefined),
          files: request.inputFiles.map(({ objectKey, sha256, sizeBytes }) => ({ objectKey, sha256, sizeBytes })) };
      },
      async workflow(threadId, epoch, action) {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(`compadre-native-events-${threadId}-${epoch}`);
        if (action === "resume") await ensureNativeThreadDeliveryWorkflow({ canonicalThreadId: threadId, epoch });
        try {
          const description = await handle.describe();
          if (action === "cancel" && description.status.name === "RUNNING") await handle.cancel();
          return { status: description.status.name, runId: description.runId,
            activities: description.raw.pendingActivities?.map((activity) => ({
              attempt: activity.attempt, lastFailure: activity.lastFailure?.message,
            })), cancellationRequested: action === "cancel" };
        } catch (error) {
          if (error instanceof Error && error.name === "WorkflowNotFoundError") return null;
          throw error;
        }
      },
    };
  },
};
const createSchema = z.object({ projectId: z.string().min(1), modelSelection: z.object({ instanceId: z.enum(["codex", "claudeAgent"]), model: z.string().min(1) }) });
const turnSchema = z.object({
  messageId: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000).default("Reply with exactly VERIFICATION_OK. Do not use tools or change files."),
  scenario: verificationScenario.default("none"), inputFiles: inputFilesSchema.default([]),
});

/** Agent-facing canaries use central commands and read the same projection as clients. */
export function createT3VerificationRoutes(deps: Dependencies = defaults): Hono {
  const app = new Hono();
  const base = "/internal/operations/verification";
  app.use(`${base}/*`, async (c, next) => {
    if (!deps.enabled()) return c.notFound();
    const denied = requireCompadreApiKey(c);
    if (denied) return denied;
    c.header("cache-control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    console.error("[t3-verification] request failed", { name: error.name });
    return c.json({ error: "Verification operation failed; inspect the thread snapshot and service logs" }, 502);
  });
  app.get(base, async (c) => {
    const resources = await deps.resources();
    if (!resources) return c.json({ error: "Verification unavailable" }, 503);
    const snapshot = await resources.central.snapshot();
    return c.json({ projects: snapshot.projects.map(({ id, title, defaultModelSelection }) => ({ id, title, defaultModelSelection })),
      scenarios: verificationScenario.options });
  });
  app.post(base, async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "projectId and native modelSelection required" }, 400);
    const resources = await deps.resources();
    if (!resources) return c.json({ error: "Verification unavailable" }, 503);
    const threadId = `verify-${randomUUID()}`;
    await resources.store.register(threadId);
    await resources.central.createThread({ ...parsed.data, threadId, title: "[Verification] API reliability canary" });
    return c.json({ threadId }, 201);
  });
  app.use(`${base}/:threadId/*`, async (c, next) => {
    const resources = await deps.resources();
    if (!resources || !await resources.store.get(c.req.param("threadId"))) return c.notFound();
    await next();
  });
  app.get(`${base}/:threadId`, async (c) => {
    const resources = (await deps.resources())!;
    const threadId = c.req.param("threadId");
    const [central, delivery, verification] = await Promise.all([
      resources.central.threadSnapshot(threadId), resources.delivery.get(threadId), resources.store.get(threadId),
    ]);
    const run = delivery?.runId ? await resources.runs.run(delivery.runId) : await resources.runs.activeRun(threadId);
    return c.json({ central, delivery, verification, run,
      requestStorage: run ? await resources.requestStorage(run.runId) : null,
      workflow: delivery ? await resources.workflow(threadId, delivery.epoch) : null });
  });
  app.post(`${base}/:threadId/turn`, async (c) => {
    const input = turnSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid verification turn" }, 400);
    const resources = (await deps.resources())!;
    const threadId = c.req.param("threadId");
    const { thread } = await resources.central.threadSnapshot(threadId);
    if (thread.messages.some((message) => message.id === input.data.messageId)) return c.json({ accepted: true, duplicate: true });
    if (await resources.runs.activeRun(threadId) || ["starting", "running"].includes(thread.session?.status ?? "")) {
      return c.json({ error: "Verification thread already has active work" }, 409);
    }
    await resources.store.arm(threadId, input.data.scenario);
    const dispatch = await resources.central.startTurn({ threadId, messageId: input.data.messageId, commandId: `verification:${input.data.messageId}`,
      text: input.data.text, inputFiles: input.data.inputFiles, modelSelection: thread.modelSelection });
    return c.json({ dispatch }, 202);
  });
  app.post(`${base}/:threadId/resume-delivery`, async (c) => {
    const resources = (await deps.resources())!;
    const threadId = c.req.param("threadId");
    const state = await resources.delivery.get(threadId);
    if (!state) return c.json({ error: "No saved delivery cursor" }, 409);
    await resources.store.arm(threadId, "none");
    return c.json({ workflow: await resources.workflow(threadId, state.epoch, "resume") }, 202);
  });
  app.post(`${base}/:threadId/stop`, async (c) => {
    const resources = (await deps.resources())!;
    const threadId = c.req.param("threadId");
    const run = await resources.runs.activeRun(threadId);
    if (run) await resources.runs.cancel(run.runId);
    const delivery = await resources.delivery.get(threadId);
    if (delivery) await resources.workflow(threadId, delivery.epoch, "cancel");
    await resources.store.arm(threadId, "none");
    await resources.central.stopSession({ threadId });
    return c.json({ stopped: true });
  });
  return app;
}
