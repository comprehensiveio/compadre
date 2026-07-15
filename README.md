# Compadre

AI operations agent for Comprehensive. Spawns headless Claude Code sessions via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) with MCP access to our infrastructure.

## MCP Servers

| Server | Transport | What it does |
|--------|-----------|-------------|
| **Datadog** | HTTP (OAuth) | Logs, metrics, traces, APM, error tracking, incidents, monitors |
| **Slack** | stdio (`@modelcontextprotocol/server-slack`) | Read/send messages via bot token |
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

- **DATADOG_MCP_CLIENT_ID / DATADOG_MCP_REFRESH_TOKEN**: OAuth credentials from Datadog MCP. The server auto-refreshes access tokens.
- **DD_LLMOBS_ENABLED / DD_LLMOBS_ML_APP**: Enable Datadog's automatic Claude Agent SDK instrumentation and attribute its agent, step, LLM, and tool spans to the `compadre` ML app.
- **SLACK_BOT_TOKEN**: `xoxb-*` token from the Compadre Slack app.
- **GOOGLE_WORKSPACE_USER_EMAIL / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN**: OAuth credentials for the Compadre Google Workspace bot user. When set, Compadre enables Google Workspace tools through `workspace-mcp`.
- **REPO_PATH**: Set to `/opt/render/repo` on Render (auto-cloned). Set to your local comp checkout for dev.
- **COMPADRE_API_KEY**: Auth token for the API. Generate with `openssl rand -hex 32`.
- **FABLE_MODEL**: Optional model ID used when a prompt includes `--fable`. Defaults to `claude-fable-5`; normal prompts use `DEFAULT_MODEL` or the built-in default.

## Deployment (Render)

Native Node.js service. Build: `npm install && npm run build`, Start: `npm start`.

Google Workspace support uses `uvx` because `workspace-mcp` runs as a Python MCP server. `npm start` installs `uvx` at startup when Google Workspace env vars are present and `uvx` is not already available.

On Render:
- REPO_PATH defaults to `/opt/render/repo` (the agent clones comp there on startup)
- The repo is refreshed every 15 minutes and reset to `main` before/after each agent session

## Architecture

```
HTTP request → Hono route → runTask() → Claude Agent SDK query()
                                           ├── MCP servers (Datadog, Slack, Linear, GitHub, Render, Postgres)
                                           └── Built-in tools (Read, Grep, Bash, etc.)
```

Each `runTask()` call spawns an independent Claude Code session. Sessions don't share state — the repo is reset to clean `main` between runs.
