/**
 * MCP server configurations for the agent.
 *
 * HTTP-based MCPs use pre-obtained tokens via environment variables.
 * Datadog uses a service access token for headless server authentication.
 * Jam uses its hosted HTTP MCP server with a PAT for headless server auth.
 * Google Workspace uses a bot-user OAuth refresh token cached for workspace-mcp.
 * Slack uses a bot token via our stdio MCP server so writes use standard Markdown.
 * Postgres MCP runs as a stdio subprocess.
 * S3 MCP runs as a stdio subprocess for read-only S3 access.
 * Vitally MCP runs as a stdio subprocess for read-only Vitally access.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATADOG_MCP_URL =
  "https://mcp.datadoghq.com/v1/mcp?toolsets=core,apm,llmobs";

/** Provider-neutral subset used by both the Agent SDK and TanStack harnesses. */
export type CompadreMcpServerConfig =
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    };
const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/calendar",
];
let hasLoggedCompDisabled = false;
let hasLoggedDatadogDisabled = false;

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function workspaceCredentialFilename(email: string): string {
  return `${encodeURIComponent(email).replaceAll("%40", "@")}.json`;
}

async function prepareGoogleWorkspaceCredentials(): Promise<string | null> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const userEmail = process.env.GOOGLE_WORKSPACE_USER_EMAIL;

  if (!clientId && !clientSecret && !refreshToken && !userEmail) {
    return null;
  }

  if (!clientId || !clientSecret || !refreshToken || !userEmail) {
    throw new Error(
      "Google Workspace MCP requires GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, and GOOGLE_WORKSPACE_USER_EMAIL"
    );
  }

  const credentialsDir =
    process.env.WORKSPACE_MCP_CREDENTIALS_DIR ??
    path.join(os.tmpdir(), "compadre-google-workspace-credentials");
  const credentialsPath = path.join(
    credentialsDir,
    workspaceCredentialFilename(userEmail)
  );
  const credentials = {
    token: null,
    refresh_token: refreshToken,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: clientId,
    client_secret: clientSecret,
    scopes: GOOGLE_WORKSPACE_SCOPES,
    expiry: null,
  };

  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });

  return credentialsDir;
}

function buildDatadogMcpServer(): CompadreMcpServerConfig | null {
  const accessToken = process.env.DATADOG_MCP_ACCESS_TOKEN;

  if (!accessToken) {
    if (!hasLoggedDatadogDisabled) {
      console.warn(
        "[mcp] Datadog MCP disabled: DATADOG_MCP_ACCESS_TOKEN is not configured"
      );
      hasLoggedDatadogDisabled = true;
    }
    return null;
  }

  return {
    type: "http" as const,
    url: process.env.DATADOG_MCP_URL ?? DEFAULT_DATADOG_MCP_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
}

function buildCompMcpServer(): CompadreMcpServerConfig | null {
  const compAppUrl = process.env.COMP_APP_URL;
  const apiKey = process.env.COMPADRE_API_KEY;

  if (!compAppUrl || !apiKey) {
    if (!hasLoggedCompDisabled) {
      console.warn(
        "[mcp] Comp MCP disabled: COMP_APP_URL and COMPADRE_API_KEY are not both configured"
      );
      hasLoggedCompDisabled = true;
    }
    return null;
  }

  return {
    type: "http" as const,
    url: `${compAppUrl}/api/mcp/compadre`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

/** Keep the database secret out of the subprocess command line. */
export function buildPostgresMcpServer(
  databaseUrl: string,
): CompadreMcpServerConfig {
  return {
    command: "node",
    args: [
      path.join(__dirname, "..", "dist", "mcp-servers", "postgres.js"),
    ],
    env: { READONLY_DATABASE_URL: databaseUrl },
  };
}

export async function buildMcpServers() {
  const datadogServer = buildDatadogMcpServer();
  const googleWorkspaceCredentialsDir =
    await prepareGoogleWorkspaceCredentials();

  const servers: Record<string, CompadreMcpServerConfig> = {
    slack: {
      command: "node",
      args: [path.join(__dirname, "..", "dist", "mcp-servers", "slack.js")],
      env: {
        SLACK_BOT_TOKEN: env("SLACK_BOT_TOKEN"),
        SLACK_TEAM_ID: env("SLACK_TEAM_ID"),
        ...(process.env.SLACK_CHANNEL_IDS
          ? { SLACK_CHANNEL_IDS: process.env.SLACK_CHANNEL_IDS }
          : {}),
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

    jam: {
      type: "http" as const,
      url: "https://mcp.jam.dev/mcp",
      headers: {
        Authorization: `Bearer ${env("JAM_MCP_PAT")}`,
      },
    },
  };

  const compAppServer = buildCompMcpServer();
  if (compAppServer) {
    servers.comp_app = compAppServer;
  }

  if (datadogServer) {
    servers["datadog-mcp"] = datadogServer;
  }

  if (process.env.READONLY_DATABASE_URL) {
    servers.postgres = buildPostgresMcpServer(
      process.env.READONLY_DATABASE_URL,
    );
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

  if (googleWorkspaceCredentialsDir) {
    const workspaceMcpExecutable =
      process.env.WORKSPACE_MCP_EXECUTABLE ?? "uvx";
    servers.google_workspace = {
      command: workspaceMcpExecutable,
      args: [
        ...(workspaceMcpExecutable === "uvx" ? ["workspace-mcp"] : []),
        "--single-user",
        "--tools",
        "docs",
        "drive",
        "sheets",
        "slides",
        "forms",
        "tasks",
        "calendar",
        "--tool-tier",
        "extended",
      ],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: env("GOOGLE_OAUTH_CLIENT_ID"),
        GOOGLE_OAUTH_CLIENT_SECRET: env("GOOGLE_OAUTH_CLIENT_SECRET"),
        USER_GOOGLE_EMAIL: env("GOOGLE_WORKSPACE_USER_EMAIL"),
        WORKSPACE_MCP_CREDENTIALS_DIR: googleWorkspaceCredentialsDir,
        MCP_SINGLE_USER_MODE: "1",
      },
    };
  }

  if (process.env.VITALLY_API_KEY) {
    servers.vitally = {
      command: "node",
      args: [path.join(__dirname, "..", "dist", "mcp-servers", "vitally.js")],
      env: {
        VITALLY_API_KEY: process.env.VITALLY_API_KEY,
      },
    };
  }

  return servers;
}
