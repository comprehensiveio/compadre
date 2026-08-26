// Ensure nvm-managed Node binaries are available to coding harness processes.
if (!process.env.PATH?.includes(process.execPath.replace(/\/node$/, ""))) {
  const nodeDir = process.execPath.replace(/\/node$/, "");
  process.env.PATH = `${nodeDir}:${process.env.PATH}`;
}

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import ddTrace from "dd-trace";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health.js";
import { promptRoutes } from "./routes/prompt.js";
import { slackEventsRoutes } from "./routes/slack-events.js";
import { webhookRoutes } from "./routes/webhook.js";
import { aguiRoutes } from "./routes/agui.js";
import { workflowRunRoutes } from "./routes/workflow-runs.js";
import { toolBridgeRoutes } from "./routes/tool-bridge.js";
import { hostedRoutes } from "./routes/hosted.js";
import { t3DirectoryRoutes } from "./routes/t3-directory.js";
import { validateConversationConfiguration } from "./conversation.js";
import {
  createSingleFlightSlackRecovery,
  DEFAULT_SLACK_RECONCILIATION_INTERVAL_MS,
  isSlackRecoveryOwner,
  recoverStaleSlackRuns,
} from "./services/slack-run-recovery.js";
import { startConfiguredPullRequestWatch } from "./services/pr-watch-runtime.js";
import { getConfiguredThreadPersistence } from "./persistence/runtime.js";
import { RUN_MEMORY_MODE } from "./tanstack/run-memory.js";
import { SlackRunStateStore } from "./services/slack-run-state.js";

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  return logger()(c, next);
});

app.onError((err, c) => {
  const span = ddTrace.scope().active();
  if (span) {
    span.setTag("error", true);
    span.setTag("error.message", err.message);
    span.setTag("error.stack", err.stack);
    span.setTag("error.type", err.constructor.name);
  }
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err.message);
  return c.json({ ok: false, error: err.message }, 500);
});

app.route("/", healthRoutes);
app.route("/", promptRoutes);
app.route("/", slackEventsRoutes);
app.route("/", webhookRoutes);
app.route("/", aguiRoutes);
app.route("/", workflowRunRoutes);
app.route("/", toolBridgeRoutes);
app.route("/", hostedRoutes);
app.route("/", t3DirectoryRoutes);

const hostedAssets = serveStatic({
  root: "./dist-web",
  rewriteRequestPath: (path) => path.replace(/^\/hosted/, ""),
});
const hostedIndex = serveStatic({ path: "./dist-web/index.html" });
app.use("/hosted/assets/*", async (c, next) => {
  if (
    process.env.COMPADRE_HOSTED_T3_ENABLED !== "true" &&
    process.env.COMPADRE_T3_DIRECTORY_ENABLED !== "true"
  ) return next();
  return hostedAssets(c, next);
});
app.get("/hosted", async (c, next) => {
  if (
    process.env.COMPADRE_HOSTED_T3_ENABLED !== "true" &&
    process.env.COMPADRE_T3_DIRECTORY_ENABLED !== "true"
  ) return c.notFound();
  return hostedIndex(c, next);
});
app.get("/hosted/", async (c, next) => {
  if (
    process.env.COMPADRE_HOSTED_T3_ENABLED !== "true" &&
    process.env.COMPADRE_T3_DIRECTORY_ENABLED !== "true"
  ) return c.notFound();
  return hostedIndex(c, next);
});

const SLACK_RECOVERY_DELAY_MS = 15_000;

const port = Number(process.env.PORT) || 3100;

async function start() {
  const threadPersistence = await getConfiguredThreadPersistence();
  if (threadPersistence) {
    console.log(
      `[persistence] TanStack thread state enabled (run memory: ${RUN_MEMORY_MODE})`,
    );
  }
  const agent = validateConversationConfiguration();
  console.log(`[agent] conversation provider=${agent.provider} harness=modal`);

  // Start the server first so Render sees the port binding
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agent] server running on port ${info.port}`);
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken && isSlackRecoveryOwner()) {
      const slackRuns = threadPersistence
        ? new SlackRunStateStore(
            threadPersistence.persistence.stores.metadata,
            threadPersistence.persistence.stores.runs,
          )
        : null;
      const recoverSlackRuns = createSingleFlightSlackRecovery(() => {
        if (!slackRuns) return Promise.resolve({ recovered: 0, scanned: 0 });
        return recoverStaleSlackRuns({
          botToken,
          resolveRun: (channel, messageTs) =>
            slackRuns.resolve(channel, messageTs),
          forgetRun: (channel, messageTs) =>
            slackRuns.forget(channel, messageTs),
        });
      });
      const scheduleSlackRecovery = () => {
        void recoverSlackRuns().catch((error) =>
          console.error("[slack-recovery] recovery failed:", error),
        );
      };
      const recoveryTimer = setTimeout(
        scheduleSlackRecovery,
        SLACK_RECOVERY_DELAY_MS,
      );
      recoveryTimer.unref();
      const recoveryInterval = setInterval(
        scheduleSlackRecovery,
        DEFAULT_SLACK_RECONCILIATION_INTERVAL_MS,
      );
      recoveryInterval.unref();
    }
  });

  // Agent repositories live in Modal. The PR deployment watcher maintains
  // its own read-only Git clone only when that optional service is configured.
  void startConfiguredPullRequestWatch(false).catch((error) =>
    console.error("[pr-watch] initialization failed:", error),
  );
}

start();
