/**
 * MCP server configurations for the agent.
 *
 * HTTP-based MCPs use pre-obtained tokens via environment variables.
 * Datadog uses OAuth refresh tokens (managed by src/auth/datadog.ts).
 * Slack uses a bot token via the stdio-based MCP server.
 * Postgres MCP runs as a stdio subprocess.
 */

import { getDatadogAccessToken } from "./auth/datadog.js";

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export async function buildMcpServers() {
  const datadogToken = await getDatadogAccessToken();

  const servers: Record<string, unknown> = {
    "datadog-mcp": {
      type: "http" as const,
      url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core,apm,error-tracking",
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

  if (process.env.DATABASE_URL) {
    servers.postgres = {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-postgres",
        process.env.DATABASE_URL,
      ],
    };
  }

  return servers;
}
