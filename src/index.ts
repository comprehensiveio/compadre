// Ensure nvm-managed node/npx are available to child processes (Claude Agent SDK)
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
import { slackRoutes } from "./routes/slack.js";
import { slackEventsRoutes } from "./routes/slack-events.js";
import { webhookRoutes } from "./routes/webhook.js";
import { aguiRoutes } from "./routes/agui.js";
import { ensureRepo, refreshRepo, cleanupStaleWorktrees } from "./repo.js";
import { validateConversationConfiguration } from "./conversation.js";

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
app.route("/", slackRoutes);
app.route("/", slackEventsRoutes);
app.route("/", webhookRoutes);
app.route("/", aguiRoutes);

// Refresh the repo clone periodically (every 15 minutes)
const REPO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const port = Number(process.env.PORT) || 3100;

async function start() {
  const agent = validateConversationConfiguration();
  console.log(
    `[agent] conversation provider=${agent.provider}`
  );

  // Start the server first so Render sees the port binding
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agent] server running on port ${info.port}`);
  });

  // Clone or update the repo in the background (can be slow)
  try {
    ensureRepo();
  } catch (err) {
    console.error("[startup] repo setup failed — agent will have no codebase access:", err);
  }

  // Periodic repo refresh and stale worktree cleanup
  const STALE_WORKTREE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
  setInterval(() => {
    refreshRepo();
    cleanupStaleWorktrees(STALE_WORKTREE_MAX_AGE_MS);
  }, REPO_REFRESH_INTERVAL_MS);
}

start();
