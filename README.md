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
- **COMPADRE_THREAD_PERSISTENCE_ENABLED**: Use `@tanstack/ai-persistence` for canonical server-side transcripts, interrupts, metadata, and thread hydration. PostgreSQL deployments reuse the durability database and serialize thread turns with advisory locks; memory durability uses the package's in-memory reference backend.
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
- Fire-and-forget `/prompt` and webhook runs use background capacity. Interactive Slack and synchronous API runs preempt them instead of waiting behind automation; accepted background work retries after foreground capacity is released.
- **COMPADRE_AGENT_TREE_MEMORY_MB / COMPADRE_CGROUP_MEMORY_HEADROOM_MB**: Bound one agent process tree and reserve service memory for graceful cleanup. Defaults are `2560` MiB and `768` MiB. Process-tree usage conservatively sums RSS, while the cgroup guard measures total service memory. A breach aborts only the active harness tree and surfaces a terminal run error.
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
before a newly built version can receive traffic. Existing environment variables
are intentionally omitted from the Blueprint: Render preserves them when the
Blueprint is linked, without putting secret values in Git. Linking the repository
to the Blueprint is a one-time Render setup; subsequent service configuration
changes and deploys sync from `main`.

Google Workspace support uses `uvx` because `workspace-mcp` runs as a Python MCP server. `npm start` installs `uvx` at startup when Google Workspace env vars are present and `uvx` is not already available.

On Render:
- REPO_PATH defaults to `/opt/render/repo` (the agent clones comp there on startup)
- The base repo is refreshed every 15 minutes
- Threads get isolated git worktrees; inactive thread state and worktrees expire together after one hour
- One isolated worktree is prepared while the harness is idle so a new thread normally avoids dependency installation on its request path; incoming user work preempts that preparation

### Ephemeral agent Workflow spike

The repository also registers three opt-in Render Workflow tasks:

- `probeAgentRuntime` measures Workflow and repository startup without calling a model.
- `runAgent` executes one existing TanStack AI agent turn on an isolated 4 GB task instance.
- `probeAgentDurability` verifies a saved run through the same Postgres replay adapter without returning its message content.

Slack remains on the persistent runner by default. The same channel-neutral
conversation interface can be switched to the Workflow producer with
`COMPADRE_SLACK_WORKFLOW_ENABLED=true` after the relay has been verified. Task
retries remain disabled until Slack and GitHub side effects have durable
idempotency, and provider session/worktree reuse remains a separate persistence
milestone.

Use these commands for local Workflow development with Render CLI 2.12 or
newer:

```bash
# Terminal 1
render workflows dev -- npm run workflow:dev

# Terminal 2
RENDER_USE_LOCAL_DEV=true npm run workflow:probe
RENDER_USE_LOCAL_DEV=true npm run workflow:agent -- "Reply with only: hi"
```

Configure the Workflow service with:

```text
Build: npm ci && npm run build && npm run workflow:prepare-runtime && npm run workflow:seed-repo
Start: npm run workflow:start
```

The build command clones a shallow editable `comp` repository into the cached
Workflow image. Because Render gives each task its own disposable instance,
the task uses that checkout directly and fetches only the latest GitHub delta.
The persistent service continues to use isolated per-thread worktrees. If the
baked checkout is missing, the runtime falls back to a partial shallow clone.
The Workflow needs the same
agent/MCP environment group as the web service plus a valid
`GITHUB_PERSONAL_ACCESS_TOKEN`; the credential is passed through Git's child
process environment and is never stored in the origin URL. A shared
`REPO_PATH` is intentionally replaced by the baked checkout for Workflow tasks;
set `COMPADRE_WORKFLOW_REPO_PATH` only if the Workflow needs a different path.

Workflow run and delivery durability uses TanStack's `RunStore`,
`StreamDurability`, and `RunController` contracts. Local development remains
database-free unless `COMPADRE_DURABILITY_BACKEND=memory` is selected. The
deployed Workflow sets the backend to `postgres`; every AG-UI chunk is persisted
before the existing Compadre consumer observes it, and can be replayed later by
the Slack delivery gateway.

The relay has a database-free local mode: set
`COMPADRE_DURABILITY_BACKEND=memory`, `COMPADRE_WORKFLOW_RUNNER=local`, and
`COMPADRE_WORKFLOW_RELAY_ENABLED=true`. `POST /workflow-runs` starts an
in-process run and `GET /workflow-runs/:runId/events?offset=-1` serves its
resumable AG-UI stream. A deployed relay switches only the runner to `render`
and the durability backend to `postgres`; the HTTP and event contracts stay
the same. Slack consumes that identical durable log through the existing
`SlackStream`; it never depends on a live connection to the Workflow task.
See [the Render Workflow cutover runbook](docs/render-workflow-cutover.md) for
the deployed topology, repeatable probe, failure semantics, and cutover steps.

## Architecture

```text
Slack / HTTP -> persistent relay -> Render Workflow -> Claude Code or Codex
                       |                  |
                       +---- Postgres <---+
                       |
                       +-> Slack stream
```

With thread persistence enabled, PostgreSQL is the canonical source for the
provider-neutral transcript and TanStack run/interrupt state. Provider-native
sessions and worktrees remain process-local optimizations; after a restart or
provider switch the runtime reconstructs context from the neutral transcript.
Runs on the same thread are serialized across processes with PostgreSQL
advisory locks, and each process runs only one coding harness at a time. A
run-scoped supervisor records safe PID/RSS telemetry and aborts the harness
process group before it can exhaust the service cgroup. The runtime reconciles
stale Slack reactions after a restart. Postgres stores run lifecycle and
ordered AG-UI delivery events. Durable workspace snapshots and exact Slack
message continuation remain deliberately deferred.
