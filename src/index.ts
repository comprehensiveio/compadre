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
import {
  cleanupStaleWorktrees,
  ensureRepo,
  refreshRepo,
  removeWorktree,
} from "./repo.js";
import { validateConversationConfiguration } from "./conversation.js";
import { recoverStaleSlackRuns } from "./services/slack-run-recovery.js";
import { harnessThreadStore } from "./tanstack/thread-state.js";
import { harnessPreparedWorktrees } from "./tanstack/prepared-worktrees.js";
import { validateRelayOnlyConfiguration } from "./services/conversation-runner.js";
import { startConfiguredPullRequestWatch } from "./services/pr-watch-runtime.js";

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

// Refresh the repo clone periodically (every 15 minutes)
const REPO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const SLACK_RECOVERY_DELAY_MS = 15_000;

const port = Number(process.env.PORT) || 3100;

async function start() {
  validateRelayOnlyConfiguration();
  const relayOnly = process.env.COMPADRE_RELAY_ONLY === "true";
  if (!relayOnly) {
    const agent = validateConversationConfiguration();
    console.log(`[agent] conversation provider=${agent.provider}`);
  } else {
    console.log("[agent] relay-only mode");
  }

  // Start the server first so Render sees the port binding
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agent] server running on port ${info.port}`);
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken) {
      const recoveryTimer = setTimeout(() => {
        void recoverStaleSlackRuns({ botToken }).catch((error) =>
          console.error("[slack-recovery] recovery failed:", error),
        );
      }, SLACK_RECOVERY_DELAY_MS);
      recoveryTimer.unref();
    }
  });

  // Clone or update the repo in the background (can be slow)
  let repositoryReady = false;
  if (!relayOnly) {
    try {
      ensureRepo();
      repositoryReady = true;
      void harnessPreparedWorktrees.refill().catch((error) =>
        console.error("[worktree-pool] startup refill failed:", error),
      );
    } catch (err) {
      console.error("[startup] repo setup failed — agent will have no codebase access:", err);
    }

    // Periodic repo refresh and stale worktree cleanup
    const STALE_WORKTREE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
    const maintainRepo = async () => {
      refreshRepo();
      harnessPreparedWorktrees.reconcile();
      harnessPreparedWorktrees.scheduleRefill();
      const expiredThreads = await harnessThreadStore.deleteStale(
        STALE_WORKTREE_MAX_AGE_MS
      );
      for (const thread of expiredThreads) removeWorktree(thread.worktreeId);
      const retainedWorktreeIds = await harnessThreadStore.worktreeIds();
      for (const worktreeId of harnessPreparedWorktrees.worktreeIds()) {
        retainedWorktreeIds.add(worktreeId);
      }
      cleanupStaleWorktrees(STALE_WORKTREE_MAX_AGE_MS, retainedWorktreeIds);
    };
    setInterval(() => {
      void maintainRepo().catch((error) =>
        console.error("[repo] maintenance failed:", error)
      );
    }, REPO_REFRESH_INTERVAL_MS);
  }

  void startConfiguredPullRequestWatch(repositoryReady).catch((error) =>
    console.error("[pr-watch] initialization failed:", error),
  );
}

start();
