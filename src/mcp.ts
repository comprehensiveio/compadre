/**
 * MCP server configurations for the agent.
 *
 * HTTP-based MCPs use pre-obtained tokens via environment variables.
 * Datadog uses OAuth refresh tokens (managed by src/auth/datadog.ts).
 * Slack uses a bot token via the stdio-based MCP server.
 * Postgres MCP runs as a stdio subprocess.
 * S3 MCP runs as a stdio subprocess for read-only S3 access.
 */

import path from "path";
import { fileURLToPath } from "url";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getDatadogAccessToken } from "./auth/datadog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export async function buildMcpServers() {
  const datadogToken = await getDatadogAccessToken();

  const servers: Record<string, McpServerConfig> = {
    "datadog-mcp": {
      type: "http" as const,
      url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core,apm,error-tracking,llmobs",
      headers: {
        Authorization: `Bearer ${datadogToken}`,
      },
    },

    slack: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: env("SLACK_BOT_TOKEN"),
        SLACK_TEAM_ID: env("SLACK_TEAM_ID"),
      },
    },

    linear: {
      type: "http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: {
        Authorization: `Bearer ${env("LINEAR_MCP_ACCESS_TOKEN")}`,
      },
    },

    github: {
      type: "http" as const,
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: `Bearer ${env("GITHUB_PERSONAL_ACCESS_TOKEN")}`,
      },
    },

    render: {
      type: "http" as const,
      url: "https://mcp.render.com/mcp",
      headers: {
        Authorization: `Bearer ${env("RENDER_API_KEY")}`,
      },
    },
  };

  if (process.env.READONLY_DATABASE_URL) {
    servers.postgres = {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-postgres",
        process.env.READONLY_DATABASE_URL,
      ],
    };
  }

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    servers.s3 = {
      command: "node",
      args: [path.join(__dirname, "..", "dist", "mcp-servers", "s3.js")],
      env: {
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
      },
    };
  }

  return servers;
}
