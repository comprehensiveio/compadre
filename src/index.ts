// Ensure nvm-managed Node binaries are available to coding harness processes.
if (!process.env.PATH?.includes(process.execPath.replace(/\/node$/, ""))) {
  const nodeDir = process.execPath.replace(/\/node$/, "");
  process.env.PATH = `${nodeDir}:${process.env.PATH}`;
}

import { serve } from "@hono/node-server";
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
import { t3DirectoryRoutes } from "./routes/t3-directory.js";
import { slackAuthRoutes } from "./routes/slack-auth.js";
import { previewGatewayRoutes } from "./routes/preview-gateway.js";
import { devBackupRoutes } from "./routes/dev-backups.js";
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
import { SlackTurnDeliveryStore } from "./services/slack-turn-delivery-store.js";
import {
  createSlackTurnDeliveryProcessor,
  DEFAULT_SLACK_DELIVERY_INTERVAL_MS,
} from "./services/slack-turn-delivery.js";
import { validateConfiguredSlackInstallation } from "./services/slack-installation.js";
import {
  configuredCentralT3Backup,
  DEFAULT_CENTRAL_T3_BACKUP_INTERVAL_MS,
} from "./services/central-t3-backup.js";
import { closeHttpServer } from "./http-shutdown.js";

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
app.route("/", t3DirectoryRoutes);
app.route("/", slackAuthRoutes);
app.route("/", previewGatewayRoutes);
app.route("/", devBackupRoutes);

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
  const slackInstallation = await validateConfiguredSlackInstallation();
  if (slackInstallation) {
    console.log(
      `[slack] verified workspace=${slackInstallation.workspaceId} botUser=${slackInstallation.botUserId}`,
    );
  }
  console.log(`[agent] conversation provider=${agent.provider} harness=modal`);

  // Start the server first so Render sees the port binding
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agent] server running on port ${info.port}`);
    if (isSlackRecoveryOwner()) {
      const backupCentralT3 = configuredCentralT3Backup();
      if (backupCentralT3) {
        let backupActive: Promise<void> | undefined;
        const scheduleBackup = () => {
          if (backupActive) return;
          backupActive = backupCentralT3()
            .then((backup) =>
              console.log("[central-t3-backup] uploaded", backup),
            )
            .catch((error) =>
              console.error("[central-t3-backup] failed:", error),
            )
            .finally(() => {
              backupActive = undefined;
            });
        };
        const initialBackup = setTimeout(scheduleBackup, 30_000);
        initialBackup.unref();
        const backupInterval = setInterval(
          scheduleBackup,
          DEFAULT_CENTRAL_T3_BACKUP_INTERVAL_MS,
        );
        backupInterval.unref();
      }
    }
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

      if (
        threadPersistence?.database &&
        process.env.COMPADRE_T3_SLACK_ENABLED === "true"
      ) {
        const processSlackDeliveries = createSlackTurnDeliveryProcessor({
          store: new SlackTurnDeliveryStore(threadPersistence.database),
          botToken,
        });
        const scheduleSlackDeliveries = () => {
          void processSlackDeliveries().catch((error) =>
            console.error("[slack-delivery] recovery failed:", error),
          );
        };
        const deliveryTimer = setTimeout(
          scheduleSlackDeliveries,
          SLACK_RECOVERY_DELAY_MS,
        );
        deliveryTimer.unref();
        const deliveryInterval = setInterval(
          scheduleSlackDeliveries,
          DEFAULT_SLACK_DELIVERY_INTERVAL_MS,
        );
        deliveryInterval.unref();
      }
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining in-flight requests`);
    const configuredTimeout = Number(
      process.env.COMPADRE_SHUTDOWN_TIMEOUT_MS ?? "295000",
    );
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 295_000;
    const forceExit = setTimeout(() => {
      console.error(`[shutdown] drain exceeded ${timeoutMs}ms`);
      process.exit(1);
    }, timeoutMs);
    void closeHttpServer(server).then(
      () => {
        clearTimeout(forceExit);
        console.log("[shutdown] in-flight requests drained");
        process.exit(0);
      },
      (error) => {
        clearTimeout(forceExit);
        console.error("[shutdown] HTTP server close failed", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Agent repositories live in Modal. The PR deployment watcher maintains
  // its own read-only Git clone only when that optional service is configured.
  void startConfiguredPullRequestWatch(false).catch((error) =>
    console.error("[pr-watch] initialization failed:", error),
  );
}

start();
