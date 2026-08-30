# Compadre

AI operations agent for Comprehensive. Slack and API requests run through a
provider-neutral TanStack AI runtime backed by Claude Code or Codex, with shared
MCP access to our infrastructure.

## MCP Servers

| Server               | Transport                                       | What it does                                                                                   |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Datadog**          | HTTP (service access token)                     | Logs, metrics, traces, APM, error tracking, incidents, monitors                                |
| **Slack**            | stdio (built in)                                | Read Slack, send standard Markdown, and upload files via bot token                             |
| **Linear**           | HTTP                                            | Issue tracking, project management                                                             |
| **GitHub**           | HTTP (Copilot MCP)                              | Repos, PRs, issues                                                                             |
| **Render**           | HTTP (`mcp.render.com`)                         | Service management, deploys, logs                                                              |
| **Jam**              | HTTP                                            | Jam recordings, diagnostics, and debugging context                                             |
| **Postgres**         | stdio (`@modelcontextprotocol/server-postgres`) | Read-only database access                                                                      |
| **S3**               | stdio (built in)                                | Read and inspect configured object storage                                                     |
| **Google Workspace** | stdio (`workspace-mcp`)                         | Google Docs, Drive, Sheets, Slides, Forms, Tasks, and Calendar access as the Compadre bot user |
| **Vitally**          | stdio (built in)                                | Read customer-success accounts, organizations, and related context                             |
| **Comp app**         | stdio (built in)                                | Read Comprehensive application data through its authenticated API                              |

Each harness gets its native coding tools plus the shared MCP tools above, with
the comp repo cloned into a thread-scoped worktree.

## Endpoints

```
GET  /health                 # Health check
POST /prompt                 # Ad-hoc prompt (Bearer COMPADRE_API_KEY)
POST /slack/events           # Primary signed Slack Events ingress
POST /ag-ui                  # Optional authenticated AG-UI stream
GET  /ag-ui?threadId=...     # Optional authenticated thread hydration
POST /hosted/t3/chat          # Native T3 remote-provider stream
GET  /hosted/t3/runs/:id/events # Resume a native provider stream by SSE cursor
POST /hosted/t3/runs/:id/cancel # Cancel an active native T3 provider run
POST /workflow-runs          # Optional durable Workflow launcher (Bearer COMPADRE_API_KEY)
GET  /workflow-runs/:id      # Durable run lifecycle status (Bearer COMPADRE_API_KEY)
GET  /workflow-runs/:id/events # Resumable AG-UI event stream (Bearer COMPADRE_API_KEY; any authenticated caller may replay a known run ID)
POST /workflow-runs/:id/cancel # Cancel an active durable run (Bearer COMPADRE_API_KEY)
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
- The Slack bot needs `reactions:read` in addition to `reactions:write` so the relay can reconcile `compadre-thinking` and `compadre-failure` against durable run state after a restart. Elapsed time alone never marks a run failed.
- **GOOGLE_WORKSPACE_USER_EMAIL / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN**: OAuth credentials for the Compadre Google Workspace bot user. When set, Compadre enables Google Workspace tools through `workspace-mcp`.
- **REPO_PATH**: Local checkout used by development and the optional PR deployment watcher. Coding-agent checkouts live in Modal and are not allocated on the Render request path.
- **COMPADRE_API_KEY**: Auth token for the API. Generate with `openssl rand -hex 32`.
- **COMP_APP_API_KEY**: Optional credential for the Comp app MCP and debug-link API when it differs from the relay's own `COMPADRE_API_KEY`.
- **CODEX_API_KEY**: API key for the Codex CLI harness; a persisted Codex login is also supported for local development.
- **COMPADRE_AGENT_PROVIDER**: Select the default Claude Code or Codex harness. `/prompt` and AG-UI callers may override it per request.
- **MODAL_TOKEN_ID / MODAL_TOKEN_SECRET**: Modal is the coding-harness runtime. Compadre bakes its pinned Claude Code and Codex CLIs into the cached Modal image, keeping per-request setup to the repository clone. A hosted-T3 worker stays warm for a bounded post-turn lease, then Compadre snapshots its stopped filesystem and terminates billed compute. The next message restores a new sandbox from that snapshot. The legacy TanStack path snapshots immediately after a persisted turn.
- **COMPADRE_T3_WORKER_WARM_TTL_MS / COMPADRE_T3_WORKER_SWEEP_INTERVAL_MS**: Control the native worker's post-turn warm lease (30 minutes by default) and the restart-safe overdue-worker sweep (one minute by default). The warm deadline is also capped before `COMPADRE_MODAL_TIMEOUT_MS`.
- **GITHUB_PERSONAL_ACCESS_TOKEN**: Required in production so Modal can clone
  the private repository and the relay can operate configured PR watches.
- **COMPADRE_PUBLIC_URL**: Public HTTPS origin of the relay. TanStack exposes each run's bearer-authenticated host-tool bridge at this origin so Modal can invoke tools that still execute on the relay. Individual tool definitions do not contain Modal-specific code.
- Runs for the same thread serialize behind its distributed lock. Different threads use independent Modal sandboxes and may execute concurrently.
- Modal isolates harness resource usage from the persistent Render relay and
  applies its own sandbox lifecycle limits.
- **COMPADRE_TANSTACK_AI_ENABLED**: Retained as a compatibility flag for the authenticated AG-UI endpoint. AG-UI request parsing and SSE framing remain compatible, but execution is delegated to the central hosted T3 thread and its native Codex or Claude harness rather than TanStack's model adapters.
- **COMPADRE_T3_DIRECTORY_ENABLED**: Enable the native-T3 controller routes. Render stores credential-free routing metadata; every external conversation owns one Modal sandbox and one native T3 thread.
- **COMPADRE_T3_SLACK_ENABLED**: Route Slack and `npm run slack:simulate` through the central hosted T3 environment and then T3's native Codex/Claude harnesses in Modal. Slack receives assistant text plus a central “View details in T3” link; the same conversation can be continued from Slack or the T3 UI without copying history between stores.
- **COMPADRE_T3_API_ENABLED**: Expose the central-T3 compatibility API. `/prompt`, `/ag-ui`, and `/workflow-runs` all resolve to the same authoritative hosted T3 thread; PostgreSQL run/event records provide idempotency, replay, status, and cancellation without becoming a second transcript store. Synchronous `/prompt` responses also include `threadId` and `detailsUrl`.
- **COMPADRE_T3_HOSTED_APP_URL**: Hosted T3 web origin used for deep links, for example `https://compadre.comprehensive.io`.
- **COMPADRE_T3_CENTRAL_URL / COMPADRE_T3_CENTRAL_TOKEN**: Central T3 environment and its scoped service-account bearer. Slack dispatches through T3's authenticated orchestration API so its turns are committed to the same event log the browser reads. Issue the bearer with T3's native `auth session issue` command.
- **COMPADRE_T3_CENTRAL_PROJECT_ID**: Optional project for new Slack-originated threads when the central T3 environment contains multiple projects. The first active project is used when omitted.
- **COMPADRE_T3_PACKAGE_PATH**: Local-only archive used to install the pinned T3 fork into a new Modal environment. Deployed environments use the verified release URL and digest instead of a host path.
- **COMPADRE_T3_ARTIFACT_BUCKET**: Optional private S3 bucket for durable files generated by isolated T3 workers. Postgres retains only content-addressed metadata; authenticated controller reads feed the central web transcript and linked Slack thread.
- **COMPADRE_T3_PACKAGE_URL / COMPADRE_T3_PACKAGE_SHA256**: HTTPS release archive and required digest for reproducible Render-to-Modal fork installation. The controller caches the verified artifact locally before copying it into a new sandbox.
- **COMPADRE_HOSTED_SLACK_DELIVERY_ENABLED**: Set to `false` to suppress browser-to-Slack mirroring during synthetic hosted probes without removing the Slack token used by agent tools. Defaults to enabled.
- **FABLE_MODEL**: Optional model ID used by Slack's `--fable` routing profile. Defaults to `claude-fable-5`; normal Claude Code prompts use `DEFAULT_MODEL` or the built-in default.

Run `npm run modal:prepare-image` to build or resolve the same cached Modal
image ahead of a local benchmark or deployment. It creates no sandbox and
prints only the image ID and elapsed time.

Slack messages choose the native T3 provider on a thread's first turn with `--sol` or `--codex`
for Codex, `--fable` for Fable through Claude Code, and `--claude-code` or `--cc`
for the normal Claude Code model. T3 fixes the provider harness after a thread
starts; use a new Slack thread to switch between Codex and Claude. Models within
the chosen provider remain selectable in T3. Routing directives are removed
before the agent prompt and conversation transcript are created.

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

The production `compadre-api` controller and `compadre-web` T3 fork are declared
in [`render.yaml`](render.yaml). Each service auto-deploys from `main` in its own
repository; a Compadre merge does not restart the web UI unless the T3 fork also
changed. Render runs `npm run db:migrate` before a new controller version can
receive traffic. Secret values live in linked Render environment groups and are
never committed. See [production secrets](docs/production-secrets.md) for the
configuration boundary and rotation procedure.

Google Workspace support uses `uvx` because `workspace-mcp` runs as a Python MCP server. `npm start` installs `uvx` at startup when Google Workspace env vars are present and `uvx` is not already available.

On Render:

- The relay accepts requests, persists conversations, and serves authenticated host tools.
- Coding-agent repositories and shell processes live in Modal, not Render `/tmp`.
- Persisted threads restore their latest Modal filesystem snapshot after their
  warm worker has been terminated; independent threads can run concurrently.
- `REPO_PATH` is only needed for local development and the optional PR deployment watcher.

### Modal agent execution

The Render Web Service is Compadre's persistent relay and controller. Slack and
HTTP requests use its durable conversation path in the deployed configuration
(and locally when durability is configured); the Claude Code or Codex process,
repository checkout, shell commands, and tests always run in a Modal sandbox.
Persisted threads restore their filesystem snapshot; one-shot requests use a
disposable sandbox. There is no Render Workflow service or runner selection
flag.

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
`COMPADRE_DURABILITY_BACKEND=memory` and either
`COMPADRE_T3_API_ENABLED=true` or `COMPADRE_WORKFLOW_RELAY_ENABLED=true`.
`POST /workflow-runs` dispatches to the central hosted T3 thread and
`GET /workflow-runs/:runId/events?offset=-1` serves a resumable compatibility
projection of that run. A deployed relay uses the PostgreSQL durability
backend; the HTTP and event contracts stay the same. The central T3 event log
remains the authoritative conversation transcript.
See [the Modal harness cutover runbook](docs/modal-harness-cutover.md) for
the remote execution boundary and deployment checks.

## Architecture

```text
Slack / compatibility API --> Compadre controller ingress --+
                              Postgres users/bindings         |
Browser -----------------------------------------------------+--> central T3 on Render
                                                                 SQLite transcript
                                                                        |
                                                                        v
                                                          Compadre execution bridge
                                                          Postgres lifecycle/recovery
                                                                        |
                                                                        v
                                                             one Modal worker/thread
```

Central T3 owns the canonical transcript rendered by the web UI. The controller
routes Slack/API ingress to that transcript. Compadre Postgres owns canonical
users and Slack identities, external bindings, run/event delivery, worker
lifecycle, and recovery metadata. Codex or Claude Code, the repository, shell,
tests, and optional development stack run in one isolated Modal worker per
canonical thread; conversation tool history remains part of central T3's
SQLite transcript.

See [the hosted T3 architecture](docs/hosted-t3-architecture.md) for data
ownership and flow. Maintainers changing any part of this system should load
[the change-compadre-stack skill](.agents/skills/change-compadre-stack/SKILL.md)
before editing.
