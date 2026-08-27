# Hosted T3 architecture

Compadre is an internal coding-agent system with Slack, API, and the native T3
web application as equivalent conversation entrypoints. The central T3 server
on Render owns durable conversation state. Compadre owns distributed execution,
Slack delivery, tool access, and recovery. Each conversation executes in its
own Modal sandbox.

## Data flow

```text
Slack / API ──┐
              ├──> central T3 on Render
Browser UI ───┘      SQLite event log + projections
                            |
                            | native Codex/Claude provider command
                            v
                    Compadre controller
                       Postgres control state
                            |
                            v
                    one Modal worker per thread
                       worker T3 server
                       Codex or Claude Code
                       isolated checkout
```

Central T3 commits a turn command before invoking the remote provider. The
Compadre controller binds that central thread to one Modal worker, streams the
worker's native T3 output back as provider events, and central T3 persists those
events before the browser or Slack renders them. Reading a completed thread
never requires waking Modal.

Codex and Claude remain T3's built-in provider identities. When
`COMPADRE_NATIVE_T3_URL` is configured, their adapters send provider work to
Compadre instead of spawning a CLI on the Render host. The T3 model picker and
provider-specific options therefore remain native T3 behavior.

Upstream T3 also assumes source-control commands and the checked-out repository
live beside its server. The hosted fork installs a pinned, checksum-verified
GitHub CLI on the central Render service, but the real checkout remains in the
thread's Modal worker. Repository and pull-request UI features therefore need a
remote source-control adapter or durable central projections; running `gh`
against Render's bootstrap workspace is not an authoritative substitute.

## Durable ownership

| Data | Owner |
| --- | --- |
| Conversation events, messages, tools, turns, approvals | Central T3 SQLite |
| Canonical users and workspace-scoped Slack identities | Compadre Postgres |
| External-thread binding, worker identity, lease and recovery metadata | Compadre Postgres |
| Checkout, live terminal, provider process and native transcript | Modal worker |
| Attachments and large artifacts | Central object storage |
| Logs, traces, model usage and cost telemetry | Datadog |

## Identity and browser access

Slack is the identity provider for the internal hosted UI. Compadre Postgres
owns canonical users and their Slack identities. Slack messages are resolved
through the bot-authenticated `users.info` API, and canonical sender
attribution is copied into the T3 message event. Web messages are attributed
from the authenticated T3 session rather than from client-supplied fields.

Browser login uses Sign in with Slack (OpenID Connect) as a confidential web
client, with state, nonce, signed-token verification, and a workspace
allowlist. The controller verifies Slack and issues a
short-lived, single-use handoff grant. Central T3 exchanges that grant
server-to-server and creates one of T3's existing persisted, signed browser
sessions. Slack tokens and service credentials never reach the browser or
Modal. In hosted Compadre mode, T3 rejects older pairing-issued browser
sessions while preserving service/bearer sessions for the relay API. Users can
explicitly sign out, which revokes the persisted T3 session and expires its
browser cookie.

The initial authorization policy is intentionally simple: every active member
of the allowed Slack workspace can access every Compadre conversation. The
canonical user boundary leaves room for thread membership and roles later.

The current controller also stores the latest complete worker T3 snapshot in
Postgres. This is a transitional recovery record and duplicates conversation
text. Replace it with a narrow execution record after durable worker-event
delivery can reconstruct central T3 without the full snapshot.

## Worker event delivery

The controller projects worker T3 snapshots into version 1 of the native T3
provider protocol. Every projected event is written to the existing Postgres
run log before delivery. The POST subscriber and later GET subscribers read the
same log using opaque SSE cursors. Closing a subscriber therefore does not
cancel the Modal run, a repeated run ID cannot start a second agent, and the T3
fork reconnects a dropped stream from its last delivered cursor.

Version 2 carries text, named tool calls, normalized token usage, and initiating
message attribution. The remaining production-hardening work is:

- Approvals and user-input requests.
- Workspace diffs, checkpoints, attachments, and shell lifecycle.
- Deferred: persisted worker dispatch metadata and controller-restart takeover.
- Deferred with takeover: epoch fencing of both the event log and terminal run
  record.

The HTTP seam negotiates `X-Compadre-T3-Protocol-Version: 2`. Postgres assigns
ordered event offsets and enforces one append sequence per run. A distributed
per-run advisory lock prevents concurrent producers while the controller is
alive. It is not yet a complete takeover implementation: after a controller
process dies, a new process can replay the stored prefix but cannot reconstruct
and continue the worker snapshot projection yet.

This is an accepted reliability tradeoff for the current internal deployment,
not an immediate roadmap item. A controller restart during an active run may
leave that run incomplete, but completed events remain durable and replayable.
Revisit takeover when observed orphaned runs make it operationally worthwhile,
when controller deploy frequency materially increases, or before running more
than one controller instance. Until then, prefer clear failure recovery and a
manual retry over the substantially more complex lease, reattachment, and
fencing protocol.

## Usage

Native usage originates in the Modal worker. Version 2 projects normalized,
idempotent usage events into the central T3 event log, where they are joined to
the initiating message attribution. The central Usage page prices those records
with the same LiteLLM rate table it uses for local provider transcripts and can
group cost and tokens by user.

The central T3 process exports the logical Agent Observability span so one turn
is not double-counted by both central and worker processes. Datadog receives
input/output content, model/provider, tokens, model-priced or provider-reported
cost, initiating user, and origin under one `compadre-t3-experiment` LLM
application. Worker and controller OpenTelemetry spans retain distinct service
names for distributed-system latency analysis.

## Deployment

The running productionization and migration work is tracked in
[Production cutover checklist](./production-cutover-checklist.md). Keep that
checklist updated as the isolated deployment reveals additional requirements.

The current internal deployment retains its existing isolated resource names:

- T3 UI: `https://t3code-compadre-experiment.onrender.com`
- Compadre controller: `https://compadre-t3-experiment.onrender.com`
- Compadre Postgres: `compadre-t3-experiment-postgres`
- Central T3 disk: 1 GB persistent disk mounted at `/var/data`

The names are deployment identifiers, not an architectural mode. The T3 server
runs in same-origin mode; `VITE_HOSTED_APP_CHANNEL` and `VITE_HOSTED_APP_URL`
remain blank. The controller requires Postgres durability and the T3 server uses
the controller's `/hosted/t3/chat` remote-provider endpoint.

The central T3 SQLite database is a single-writer deployment. Before treating it
as production-critical state, add continuous encrypted backup, scheduled restore
verification, integrity checks, disk-capacity alerts, and a documented recovery
time objective. Do not add another Render instance until write ownership is
explicit.

The controller is also kept at one instance today. Native T3 run events and
cancel intent are durable, but active tool bridges and the immediate cancel path
are still process-local. Multi-instance operation additionally requires
persisted dispatch metadata, epoch fencing, heartbeat/lease expiry, and a
durable command inbox so a deploy cannot orphan an active Modal callback.

## Configuration

Controller:

```text
COMPADRE_T3_DIRECTORY_ENABLED=true
COMPADRE_T3_SLACK_ENABLED=true
COMPADRE_T3_API_ENABLED=true
COMPADRE_DURABILITY_BACKEND=postgres
COMPADRE_T3_CENTRAL_URL=https://t3code-compadre-experiment.onrender.com
COMPADRE_T3_CENTRAL_TOKEN=<scoped T3 bearer>
COMPADRE_SLACK_WORKSPACE_ID=<allowed Slack workspace ID>
SLACK_CLIENT_ID=<Sign in with Slack client ID>
SLACK_CLIENT_SECRET=<Sign in with Slack client secret>
SLACK_OIDC_REDIRECT_URI=https://compadre-t3-experiment.onrender.com/auth/slack/callback
COMPADRE_AUTH_EXCHANGE_SECRET=<random shared controller/T3 credential>
COMPADRE_T3_PACKAGE_URL=<pinned fork release>
COMPADRE_T3_PACKAGE_SHA256=<required digest>
```

The Compadre T3 fork defaults `enableAgentBrowserAccess` to `false`. This is a
server-side provider boundary: workers do not mint the `t3-code` MCP credential,
attach the browser MCP server, or include `preview_*` tool descriptions in agent
prompts. The user-facing web application remains available; this setting only
removes agent control of T3's in-app preview browser.

Central T3:

```text
COMPADRE_NATIVE_T3_URL=https://compadre-t3-experiment.onrender.com/hosted/t3/chat
COMPADRE_CONTROLLER_URL=https://compadre-t3-experiment.onrender.com
COMPADRE_AUTH_EXCHANGE_SECRET=<same random controller/T3 credential>
VITE_COMPADRE_AUTH_ENABLED=true
T3CODE_INSTALL_GH_CLI=true
GH_TOKEN=<repository-scoped token for T3 source-control UI>
COMPADRE_PROVIDER_URL=
```

`COMPADRE_PROVIDER_URL` belongs to the removed first-generation Compadre provider
and must stay unset. The supported architecture exposes native `codex` and
`claudeAgent` providers only.

## Security and retention

The controller currently authenticates internal routes with a shared bearer.
Before expanding access, bind user and Slack workspace identities to thread
ownership, authorize every read and command, and record an audit event.

The versioned event envelope already permits an optional actor reference. It is
intentionally unused until authentication establishes trustworthy identities;
the system must not turn unverified Slack display names into authorization data.

Conversation deletion must eventually propagate to central T3, Postgres recovery
records, Modal snapshots, provider-native transcripts, attachments, Slack where
appropriate, and Datadog according to its retention policy. Datadog content is
redacted and bounded, but it is still a retained copy and belongs in the data
inventory.

## Slack application

The checked-in [Slack manifest](./slack-app-manifest.t3-experiment.yaml) targets
the isolated controller hostname. It accepts direct-message and `app_mention`
events and dynamically resolves the installation-specific bot identity. Do not
point the existing production Slack app at this endpoint; install a distinct app
when end-to-end testing begins.

The isolated Comprehensive workspace installation is `Secret dre experiment`
(app `A0BT4LVRRTL`, bot user `U0BT6K6FZPT`, workspace `T01N1PDFS5V`). Its
request URL is the manifest's `/slack/events` endpoint and is verified by Slack.
The bot token and signing secret belong only in the
`compadre-t3-experiment` Render environment; never copy them into source,
central T3, or the existing Compadre service.
