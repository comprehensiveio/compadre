# Compadre

AI operations agent for Comprehensive. Slack and API requests run through a
provider-neutral TanStack AI runtime backed by Claude Code or Codex, with shared
MCP access to our infrastructure.

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

Each harness gets its native coding tools plus the shared MCP tools above, with
the comp repo cloned into a thread-scoped worktree.

## Endpoints

```
GET  /health                 # Health check
POST /prompt                 # Ad-hoc prompt (Bearer COMPADRE_API_KEY)
POST /slack/events           # Primary signed Slack Events ingress
POST /ag-ui                  # Optional authenticated AG-UI stream
GET  /ag-ui?threadId=...     # Optional authenticated thread hydration
POST /workflow-runs          # Optional durable Workflow launcher (Bearer COMPADRE_API_KEY)
GET  /workflow-runs/:id/events # Resumable AG-UI event stream (Bearer COMPADRE_API_KEY; any authenticated caller may replay a known run ID)
POST /webhook/:source        # Generic webhook (Bearer COMPADRE_API_KEY)
```

## Local Dev

```bash
cp .env.example .env.local   # Fill in all values
npm install
npm run dev                  # tsx watch on port 3100
npm run test:thread-persistence # database-free two-turn persistence regression
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
- **DD_SERVICE / DD_LLMOBS_ENABLED / DD_LLMOBS_ML_APP / DD_TRACE_OTEL_ENABLED**: Attribute TanStack's provider-neutral OpenTelemetry agent/model/tool spans to Compadre in Datadog. Compadre defaults these on at startup unless explicitly overridden.
- **DD_METRICS_OTEL_ENABLED**: Export TanStack's GenAI token and duration histograms through `dd-trace`.
- **COMPADRE_DURABILITY_BACKEND / COMPADRE_DURABILITY_DATABASE_URL**: Persist TanStack run lifecycle records and ordered AG-UI delivery events. The default is off, `memory` enables database-free local replay, and deployed Workflows use `postgres` with a dedicated URL.
- **Thread persistence**: Conversations with stable thread IDs automatically use `@tanstack/ai-persistence` whenever durability is configured. PostgreSQL deployments reuse the durability database and serialize thread turns with advisory locks; memory durability uses the package's in-memory reference backend.
- **Run memory**: Whenever thread persistence is active, durable per-run tool and reasoning memory is projected into model context when a turn cannot resume a native harness session (fresh host, expired session, provider switch). The kill switch is code-level: `RUN_MEMORY_MODE` in `src/tanstack/run-memory.ts` (`on` records and injects, `observe` records only, `off` disables). See `docs/run-memory-middleware.md`.
- The Slack agent can register durable production watches for `comprehensiveio/comp` PRs. Watches use `COMPADRE_DURABILITY_DATABASE_URL`, confirm the primary `cm-app-*` web service in Render's `CM → Prod` environment, and reconcile every two minutes. They recognize normal merges, squash merges, and patch-equivalent cherry-picks.
- **READONLY_DATABASE_URL**: Must use a dedicated least-privilege role with only `CONNECT`, required schema `USAGE`, and `SELECT` grants. Revoke ownership, DML, DDL, and elevated server-file privileges; the MCP server's read-only transaction and bounded cursor are defense in depth.
- **SLACK_BOT_TOKEN**: `xoxb-*` token from the Compadre Slack app.
- The Slack bot needs `reactions:read` in addition to `reactions:write` so a restarted instance can replace interrupted `compadre-thinking` reactions with `compadre-failure`.
- **GOOGLE_WORKSPACE_USER_EMAIL / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN**: OAuth credentials for the Compadre Google Workspace bot user. When set, Compadre enables Google Workspace tools through `workspace-mcp`.
- **REPO_PATH**: Set to `/opt/render/repo` on Render (auto-cloned). Set to your local comp checkout for dev.
- **COMPADRE_PREPARED_WORKTREES**: Number of fully initialized, unclaimed worktrees kept ready for new threads. Defaults to `1` and is bounded to `0-2`; set to `0` to disable prewarming. A waiting user run cancels background preparation and takes capacity first.
- **COMPADRE_API_KEY**: Auth token for the API. Generate with `openssl rand -hex 32`.
- **CODEX_API_KEY**: API key for the Codex CLI harness; a persisted Codex login is also supported for local development.
- **COMPADRE_AGENT_PROVIDER**: Select the default Claude Code or Codex harness. `/prompt` and AG-UI callers may override it per request.
- **DAYTONA_API_KEY / COMPADRE_DAYTONA_SNAPSHOT**: Daytona is the only coding-harness runtime. Authenticate it and optionally start from a prepared runtime snapshot. Without a snapshot, Compadre installs its pinned Claude Code and Codex CLI versions during sandbox setup.
- **GITHUB_PERSONAL_ACCESS_TOKEN**: Required in production so Daytona can clone
  the private repository and the relay can operate configured PR watches.
- **COMPADRE_PUBLIC_URL**: Public HTTPS origin of the relay. TanStack exposes each run's bearer-authenticated host-tool bridge at this origin so Daytona can invoke tools that still execute on the relay. Individual tool definitions do not contain Daytona-specific code.
- Fire-and-forget `/prompt` and webhook runs use background capacity. Interactive Slack and synchronous API runs preempt them instead of waiting behind automation; accepted background work retries after foreground capacity is released.
- Daytona isolates harness resource usage from the persistent Render relay and
  applies its own sandbox lifecycle limits.
- **COMPADRE_TANSTACK_AI_ENABLED**: Expose the authenticated AG-UI endpoint without changing Slack routing.
- **FABLE_MODEL**: Optional model ID used by Slack's `--fable` routing profile. Defaults to `claude-fable-5`; normal Claude Code prompts use `DEFAULT_MODEL` or the built-in default.

Slack messages can override the default for one turn with `--sol` or `--codex`
for Codex, `--fable` for Fable through Claude Code, and `--claude-code` or `--cc`
for the normal Claude Code model. Routing directives are removed before the
agent prompt and conversation transcript are created.

## Database schema and migrations

Compadre's PostgreSQL schema is declared in `src/db/schema.ts`, with generated
SQL migrations committed under `drizzle/`. Drizzle uses the existing
`COMPADRE_DURABILITY_DATABASE_URL`; local commands load it from `.env.local`.

```bash
npm run db:generate -- --name=describe_change # generate a migration
npm run db:check                              # validate migration history
npm run db:migrate                            # apply pending migrations
npm run db:studio                             # inspect the configured database
```

Run `db:migrate` as an explicit deployment step before starting code that
depends on a new schema. Runtime durability and PR-watch queries use the typed
Drizzle schema; schema creation and changes belong exclusively in committed
migrations.

## Deployment (Render)

Native Node.js service. Build: `npm ci --include=dev && npm run build`, Start: `npm start`.

The active `compadre-relay` Web Service is declared in [`render.yaml`](render.yaml).
Render runs `npm run db:migrate` as its pre-deploy command, so migrations finish
before a newly built version can receive traffic. Secret environment variables
are either omitted from the Blueprint or declared with `sync: false`; Render
preserves their existing dashboard values during Blueprint updates without
putting those values in Git. Linking the repository to the Blueprint is a one-time
Render setup; subsequent service configuration changes and deploys sync from
`main`.

Google Workspace support uses `uvx` because `workspace-mcp` runs as a Python MCP server. `npm start` installs `uvx` at startup when Google Workspace env vars are present and `uvx` is not already available.

On Render:
- REPO_PATH defaults to `/opt/render/repo` (the agent clones comp there on startup)
- The base repo is refreshed every 15 minutes
- Threads get isolated git worktrees; inactive thread state and worktrees expire together after one hour
- One isolated worktree is prepared while the harness is idle so a new thread normally avoids dependency installation on its request path; incoming user work preempts that preparation

### Daytona agent execution

The Render Web Service is Compadre's persistent relay and controller. Slack and
HTTP requests always enter its durable conversation path; the Claude Code or
Codex process, repository checkout, shell commands, and tests always run in a
run-scoped Daytona sandbox. There is no Render Workflow service or runner
selection flag.

Slack makes at most one automatic continuation turn when an agent returns a
clean but incomplete terminal outcome. It reuses the persisted thread with a
fresh run ID and instructs the agent not to repeat completed side effects.
Thrown failures, content-filter stops, and Slack delivery truncation are not
retried; every terminal failure receives a sanitized thread message.

Run and delivery durability uses TanStack's `RunStore`,
`StreamDurability`, and `RunController` contracts. Local development remains
database-free unless `COMPADRE_DURABILITY_BACKEND=memory` is selected. The
deployed service sets the backend to `postgres`; every AG-UI chunk is persisted
before the existing Compadre consumer observes it, and can be replayed later by
the Slack delivery gateway.

For database-free local controller testing, set
`COMPADRE_DURABILITY_BACKEND=memory` and
`COMPADRE_WORKFLOW_RELAY_ENABLED=true`. `POST /workflow-runs` starts an
in-process run and `GET /workflow-runs/:runId/events?offset=-1` serves its
resumable AG-UI stream. A deployed relay uses the PostgreSQL durability
backend; the HTTP and event contracts stay the same. Slack consumes that
durable log through the existing `SlackStream`; it does not depend on the
Daytona process staying connected to Slack.
See [the Daytona harness cutover runbook](docs/daytona-harness-cutover.md) for
the remote execution boundary and deployment checks.

## Architecture

```text
Slack / HTTP -> persistent Render relay/controller -> Daytona harness
                              |                         |
                              +-> Postgres              +-> repo/shell/tests
                              +-> MCP/private tools (via authenticated bridge)
                              +-> Slack stream
```

The persistent relay keeps Postgres, Slack,
MCP clients, and private-network tool execution on Render. Claude Code or Codex,
the repository, shell commands, and tests run in a run-scoped Daytona sandbox.

When durability is configured, its persistence backend is the
canonical source for the provider-neutral transcript and TanStack run/interrupt
state. Production uses PostgreSQL for restart durability and cross-process
advisory locking; memory mode is process-local and provides neither guarantee.
Provider-native sessions and worktrees remain process-local optimizations; after
a restart or provider switch the PostgreSQL runtime reconstructs context from
the neutral transcript. Each process runs only one coding harness at a time. A
run-scoped supervisor records safe PID/RSS telemetry and aborts the harness
process group before it can exhaust the service cgroup. The runtime reconciles
stale Slack reactions after a restart. Postgres stores run lifecycle and
ordered AG-UI delivery events. Durable workspace snapshots and exact Slack
message continuation remain deliberately deferred.
