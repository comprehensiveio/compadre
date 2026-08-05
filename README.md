# Compadre

AI operations agent for Comprehensive. Slack and API requests can run through
the legacy Claude Agent SDK or a provider-neutral TanStack AI runtime backed by
Claude Code or Codex, with shared MCP access to our infrastructure.

## MCP Servers

| Server | Transport | What it does |
|--------|-----------|-------------|
| **Datadog** | HTTP (service access token) | Logs, metrics, traces, APM, error tracking, incidents, monitors |
| **Slack** | stdio (built in) | Read Slack, send standard Markdown, and upload files via bot token |
| **Linear** | HTTP | Issue tracking, project management |
| **GitHub** | HTTP (Copilot MCP) | Repos, PRs, issues |
| **Render** | HTTP (`mcp.render.com`) | Service management, deploys, logs |
| **Postgres** | stdio (`@modelcontextprotocol/server-postgres`) | Read-only database access |
| **Google Workspace** | stdio (`workspace-mcp`) | Google Docs, Drive, Sheets, Slides, Forms, Tasks, and Calendar access as the Compadre bot user |

The agent also gets all built-in Claude Code tools (Read, Grep, Glob, Bash, Edit, Write, WebSearch, WebFetch) with the comp repo cloned locally.

## Endpoints

```
GET  /health                 # Health check
POST /prompt                 # Ad-hoc prompt (Bearer COMPADRE_API_KEY)
POST /slack/events           # Primary signed Slack Events ingress
POST /ag-ui                  # Optional authenticated AG-UI stream
POST /webhook/:source        # Generic webhook (fire-and-forget)
```

## Local Dev

```bash
cp .env.example .env.local   # Fill in all values
npm install
npm run dev                  # tsx watch on port 3100
```

Test with curl:
```bash
curl -X POST http://localhost:3100/prompt \
  -H "Authorization: Bearer $COMPADRE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Check Datadog for any active alerts"}'
```

## Environment Variables

See `.env.example` for the full list. Key notes:

- **DATADOG_MCP_ACCESS_TOKEN**: A Datadog Service Access Token (recommended for the deployed service) or Personal Access Token. It is sent as a bearer token to Datadog's stable MCP endpoint; no API key or OAuth refresh token is required.
- **DATADOG_MCP_URL**: Optional endpoint override for another Datadog site or toolset selection. Defaults to US1 with the `core`, `apm`, and `llmobs` toolsets.
- **DD_SERVICE / DD_LLMOBS_ENABLED / DD_LLMOBS_ML_APP / DD_TRACE_OTEL_ENABLED**: Attribute legacy Claude SDK telemetry and TanStack's provider-neutral OpenTelemetry agent/model/tool spans to Compadre in Datadog. Compadre defaults these on at startup unless explicitly overridden.
- **DD_METRICS_OTEL_ENABLED**: Export TanStack's GenAI token and duration histograms through `dd-trace`.
- **SLACK_BOT_TOKEN**: `xoxb-*` token from the Compadre Slack app.
- **GOOGLE_WORKSPACE_USER_EMAIL / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN**: OAuth credentials for the Compadre Google Workspace bot user. When set, Compadre enables Google Workspace tools through `workspace-mcp`.
- **REPO_PATH**: Set to `/opt/render/repo` on Render (auto-cloned). Set to your local comp checkout for dev.
- **COMPADRE_API_KEY**: Auth token for the API. Generate with `openssl rand -hex 32`.
- **COMPADRE_AGENT_RUNTIME / COMPADRE_AGENT_PROVIDER**: Select the legacy or TanStack runtime and the Claude Code or Codex harness.
- **COMPADRE_TANSTACK_SLACK_USER_IDS**: Optional comma-separated Slack user canary. Listed users use TanStack while everyone else remains on legacy.
- **COMPADRE_TANSTACK_AI_ENABLED**: Expose the authenticated AG-UI endpoint without changing Slack routing.
- **FABLE_MODEL**: Optional model ID used when a prompt includes `--fable`. Defaults to `claude-fable-5`; normal prompts use `DEFAULT_MODEL` or the built-in default.

## Deployment (Render)

Native Node.js service. Build: `npm install && npm run build`, Start: `npm start`.

Google Workspace support uses `uvx` because `workspace-mcp` runs as a Python MCP server. `npm start` installs `uvx` at startup when Google Workspace env vars are present and `uvx` is not already available.

On Render:
- REPO_PATH defaults to `/opt/render/repo` (the agent clones comp there on startup)
- The repo is refreshed every 15 minutes and reset to `main` before/after each agent session

## Architecture

```
Slack or /prompt → runConversation() ─┬→ legacy Claude Agent SDK
                                     └→ TanStack AI ─┬→ Claude Code
                                                     └→ Codex
                                                           │
                                  shared worktree, MCP, sessions, telemetry
```

Slack threads retain their worktree and provider-scoped native sessions in the
current process. Postgres durability across restarts is deliberately deferred.
