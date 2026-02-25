import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// Ensure nvm-managed node/npx are available to child processes (Claude Agent SDK)
if (!process.env.PATH?.includes(process.execPath.replace(/\/node$/, ""))) {
  const nodeDir = process.execPath.replace(/\/node$/, "");
  process.env.PATH = `${nodeDir}:${process.env.PATH}`;
}

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health.js";
import { promptRoutes } from "./routes/prompt.js";
import { webhookRoutes } from "./routes/webhook.js";
import { ensureRepo, refreshRepo } from "./repo.js";
import { initDatadogAuth } from "./auth/datadog.js";

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  return logger()(c, next);
});
app.route("/", healthRoutes);
app.route("/", promptRoutes);
app.route("/", webhookRoutes);

// Refresh the repo clone periodically (every 15 minutes)
const REPO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const port = Number(process.env.PORT) || 3100;

async function start() {
  // Initialize Datadog OAuth token refresh
  initDatadogAuth({
    clientId: process.env.DATADOG_MCP_CLIENT_ID!,
    refreshToken: process.env.DATADOG_MCP_REFRESH_TOKEN!,
  });

  // Start the server first so Render sees the port binding
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agent] server running on port ${info.port}`);
  });

  // Check DD agent connectivity
  if (process.env.DD_AGENT_HOST) {
    const host = process.env.DD_AGENT_HOST;
    fetch(`http://${host}:8126/info`)
      .then((r) => r.text().then((t) => console.log(`[dd-agent] reachable at ${host}:8126, status=${r.status}`)))
      .catch((e) => console.error(`[dd-agent] unreachable at ${host}:8126:`, e.message));
  }

  // Clone or update the repo in the background (can be slow)
  try {
    ensureRepo();
  } catch (err) {
    console.error("[startup] repo setup failed — agent will have no codebase access:", err);
  }

  // Periodic repo refresh
  setInterval(refreshRepo, REPO_REFRESH_INTERVAL_MS);
}

start();
