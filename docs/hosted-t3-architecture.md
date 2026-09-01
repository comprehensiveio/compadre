# Hosted T3 architecture

Compadre is an internal coding-agent system with Slack, API, and the native T3
web application as equivalent conversation entrypoints. The central T3 server
on Render owns durable conversation state. Compadre owns distributed execution,
Slack delivery, tool access, and recovery. Each conversation executes in its
own Modal sandbox.

## Data flow

```text
Slack / API --> Compadre controller ingress --+
                Postgres users/bindings         |
Browser UI -------------------------------------+--> central T3 on Render
                                                    SQLite event log + projections
                                                               |
                                                               v
                                                    Compadre execution bridge
                                                    Postgres lifecycle/recovery
                                                               |
                                                               v
                                                    one Modal worker per thread
                                                    worker T3 + provider + checkout
```

The controller resolves Slack/API ingress to a canonical central thread.
Central T3 commits a turn command before invoking the remote provider. The
controller then binds that central thread to one Modal worker, streams the
worker's native T3 output back as provider events, and central T3 persists
those events before the browser or Slack renders them. Reading a completed
thread never requires waking Modal.

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

## Worker lifecycle and idle cost

Native T3 workers use a durable lifecycle recorded with the thread binding in
Postgres:

```text
running -> warm -> hibernating -> suspended -> restoring -> running
```

After a terminal turn, the worker remains warm for 30 minutes by default. The
controller then stops the optional dev stack, stops the worker-local T3 server,
captures a Modal filesystem snapshot, records the image ID, and terminates the
sandbox. The snapshot includes `/workspace`, worker-local T3 state under
`/var/lib/t3`, and stopped local database files. It does not preserve running
processes.

A later message creates a new Modal sandbox from that image, reprojects current
credentials and signed artifact URLs, restarts T3, verifies the assigned
project/thread and protected Slack destination, and continues the same native
T3 thread. With the default seven-day snapshot TTL, a message after three hours
resumes from the saved filesystem and transcript. This is restoration into a
new sandbox ID, not revival of the terminated sandbox.

The warm deadline is capped five minutes before Modal's configured hard sandbox
timeout. An in-process timer handles the normal path and a Postgres-backed
sweeper reconstructs overdue work after a controller restart. Preview lookup
does not wake a suspended worker; sending a new message does. After the snapshot
TTL expires, the central transcript remains readable, but the worker filesystem
can no longer be restored from that image.

Modal sandboxes receive credential-free cost tags for environment, purpose,
provider, dev-environment status, worker generation, and a hashed thread key.
Lifecycle transitions and live duration are emitted as
`compadre.t3.worker.lifecycle.transitions` and
`compadre.t3.worker.live.duration`. Use those with Modal billing exports to
track worker-hours and detect warm workers that outlive their lease.

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

### Cross-entrypoint steering

A message sent while a turn is already generating is a steer, whether it came
from Slack or the browser. Central T3 stops reading the older controller stream
without cancelling its durable producer, then sends the newer message to the
same thread-scoped Modal T3 session. The native Claude/Codex adapter folds that
message into the running turn. The older controller run is allowed to reach a
durable terminal state so recovery and accounting remain trustworthy.

Only the newest user message in the turn owns the eventual Slack answer, thread
status, and web link. Older Slack outbox rows and browser mirrors settle as
superseded without posting failure warnings, duplicate answers, or clearing a
newer turn's status.

Version 2 carries text, named tool calls, normalized token usage, and initiating
message attribution. The remaining production-hardening work is:

- Approvals and user-input requests.
- Workspace diffs, checkpoints, attachments, and shell lifecycle.
- Worker-pushed incremental checkpoints so recovery need not re-read a full
  worker snapshot.
- Wider multi-instance command delivery for process-local tool bridges.

The HTTP seam negotiates `X-Compadre-T3-Protocol-Version: 2`. Postgres assigns
ordered event offsets and enforces one append sequence per run. Fresh and
resumed drivers claim a monotonically increasing durable epoch. Event-log
appends, stream close, and terminal run-record writes are fenced against that
epoch so a retiring controller cannot duplicate prose or tool arguments after
a replacement claims the run.

Under the default Temporal orchestrator (below), the run's drive activity is
the only native-run producer: its retries reattach after a controller restart,
so neither subscriber-triggered nor startup reattachment is needed for native
runs. The following two in-process recovery paths remain implemented and
active when `NATIVE_T3_RUN_ORCHESTRATOR` is set to `"in-process"`:

The provider transport reconnects with `GET /hosted/t3/runs/:runId/events`.
When that request reaches a controller that is not already driving the run, the
controller reconnects to the existing Modal T3 thread, identifies the already
dispatched turn from its worker snapshot, and reprojects the full narration and
tool history without sending another provider request. The central T3 service's
exclusive SQLite disk is a separate deployment-availability limitation
described below.

The worker binding also records the exact active native provider run ID after
dispatch (both orchestrator modes maintain this marker for diagnostics and
sweeps). In in-process mode, five seconds after controller startup, Compadre
scans only bindings that are both `working` and carry that marker, claims a new
fenced driver epoch, and starts the same snapshot-reprojection path. Terminal
completion clears the marker conditionally, so a late retiring driver cannot
clear a newer run's identity.

The legacy/API compatibility stream is a second durable run, because its
external run and thread IDs intentionally differ from the central T3 provider
run. It is marked with a recovery owner when created and uses the outer run ID
as the deterministic central T3 message ID. Startup reconciliation first
reattaches the provider run, then claims a new epoch for each marked outer run
and tails that exact central message to terminal state. A running snapshot
seeds projector state without replaying the already-persisted prefix. This
keeps API status and replay from remaining `running` after a healthy provider
turn survives a Render rollout.

If the central turn already became terminal during the controller handoff, the
compatibility log appends only the terminal outcome. It intentionally does not
attempt a racy reconstruction of prose or tools that may already be in the
Postgres prefix; the complete transcript remains available from central T3.

Waiting is progress-aware. The central turn may run for up to 115 minutes, but
must produce a newer durable T3 snapshot within 20 minutes. The worker-provider
projection uses the same absolute ceiling derived from the Modal sandbox's
remaining lifetime and a 30-minute no-progress default. A new snapshot sequence
renews only the inactivity deadline; it never extends the absolute deadline.

## Thread operations diagnostics

`GET /internal/operations/threads` is the controller's authenticated,
read-only agent debugging API. It combines the durable T3 thread binding,
active run record, and recent Postgres stream events into one ordered snapshot.
Rows report the current phase or tool, provider and model, expected Modal
container state and generation, time since durable progress, and a derived
`healthy`, `attention`, or `stuck` classification. Stuck rows are ordered first.

The hidden hosted UI at `/operations/threads` reads the same snapshot through
an authenticated same-origin T3 proxy. The browser never receives the
controller API key. The API deliberately does not contact every Modal sandbox:
`container.status` is the controller's durable expected lifecycle state, which
keeps the page read-only and avoids waking suspended workers. If expected and
actual Modal state begin to diverge in practice, add a background Modal
inventory reconciler rather than probing sandboxes during page reads.

### Further run hardening

The current recovery path is intentionally a small first production slice. If
run volume or controller concurrency grows, harden it in this order:

1. Have workers push append-only activity checkpoints to central storage while
   generating, rather than relying on periodic full-snapshot reads.
   This would also let compatibility-stream takeover reproduce activity from
   the narrow controller-handoff interval; today that detail remains canonical
   in central T3 even if the compatibility event log omits it.
2. Add an explicit driver lease/heartbeat and alert on `working` bindings whose
   marker has no current heartbeat or whose snapshot sequence is stale.
3. Reconcile the narrow crash window between worker dispatch and active-run
   marker persistence by storing dispatch and marker in one durable command
   record.
4. Before running multiple controller replicas, add one elected reconciliation
   owner (or a distributed claim queue) so startup scans do not churn driver
   epochs.
5. Keep a synthetic long-run rollout canary that asserts one dispatch, retained
   narration/tools, terminal durable status, and one final Slack delivery.

## Durable run orchestration (Temporal)

Native T3 run execution is orchestrated by a self-hosted Temporal server
(`compadre-temporal` in render.yaml; `docker compose up -d` locally). The
selector is the code constant `NATIVE_T3_RUN_ORCHESTRATOR` in
`src/temporal/mode.ts`; `"in-process"` restores the fire-and-forget driver
plus the in-process recovery paths above as the rollback.

One `nativeT3RunWorkflow` (deterministic workflow id derived from the run id)
owns each run:

- `/hosted/t3/chat` persists the full serializable run request
  (`src/t3/run-request-store.ts`) and launches the workflow with only
  `{runId, threadId}`; a duplicate launch is a no-op.
- The drive activity (`src/t3/native-t3-run-driver.ts`) claims the same
  durable driver epoch used by in-process drivers, dispatches the worker turn
  at most once (a durable dispatch record is written right after
  `gateway.send`), maintains the binding's active-run marker, and appends
  fenced projected events to the Postgres run log. One attempt may watch for
  the worker's full lifetime (130-minute start-to-close); heartbeats detect a
  dead controller within two minutes. Activity cancellation interrupts the
  worker turn only when the run carries durable `cancelRequested` — attempt
  timeouts and worker drain hand off silently to the next attempt. On retry it rebuilds the
  projector from the chunks already persisted
  (`NativeT3SnapshotProjector.restore`) and reattaches to the running turn, so
  a controller restart moves the watch to the replacement instance without
  duplicating events. Transient watch failures throw and are retried; only
  genuine provider terminals and explicit cancellation terminalize the run.
- A non-cancellable finalize activity converges every abandoned run to a
  terminal record, closes the event log, clears the active-run marker, and
  releases the worker into its warm lease.
- Cancellation is durable: cancel intent is recorded in Postgres and the
  workflow is cancelled; the drive activity interrupts the worker turn.

The Temporal worker runs inside the `compadre-api` process on the
`compadre-native-t3` task queue. Startup fails fast when the Temporal server is
unreachable, which blocks a bad deploy from receiving traffic. During the
rollout overlap between an in-process-orchestrated retiring instance and a
Temporal-orchestrated replacement, epoch fencing keeps exactly one producer per
run. See [Temporal orchestration](./temporal-orchestration.md) for operations.

## Usage

Native usage originates in the Modal worker. Version 2 projects normalized,
idempotent usage events into the central T3 event log, where they are joined to
the initiating message attribution. The central Usage page prices those records
with the same LiteLLM rate table it uses for local provider transcripts and can
group cost and tokens by user.

The central T3 process exports the logical Agent Observability span so one turn
is not double-counted by both central and worker processes. Datadog receives
input/output content, model/provider, tokens, model-priced or provider-reported
cost, initiating user, and origin under one `compadre` LLM
application. Worker and controller OpenTelemetry spans retain distinct service
names for distributed-system latency analysis.

## Deployment

The running productionization and migration work is tracked in
[Production cutover checklist](./production-cutover-checklist.md). Keep that
checklist updated as the isolated deployment reveals additional requirements.

The production deployment uses stable Comprehensive domains and resource names:

- T3 UI: `https://compadre.comprehensive.io` (Render service
  `compadre-web`)
- Compadre controller: `https://compadre-api.comprehensive.io` (Render service
  `compadre-api`)
- Compadre Postgres: the existing production durability database
- Central T3 disk: 1 GB persistent disk mounted at `/var/data`

The T3 server runs in same-origin mode; `VITE_HOSTED_APP_CHANNEL` and
`VITE_HOSTED_APP_URL` remain blank. The controller requires Postgres durability
and the T3 server uses the controller's `/hosted/t3/chat` remote-provider
endpoint. Merges to the Compadre and T3 fork `main` branches independently
auto-deploy `compadre-api` and `compadre-web`; per-thread Modal sandboxes remain
lazy runtime resources and are not redeployed by either merge.

The central T3 SQLite database is a single-writer deployment. Before treating it
as production-critical state, add continuous encrypted backup, scheduled restore
verification, integrity checks, disk-capacity alerts, and a documented recovery
time objective. Do not add another Render instance until write ownership is
explicit.

### Known TODO: eliminate disk-coupled web deployment downtime

`compadre-web` currently keeps the authoritative T3 SQLite database on one
Render persistent disk. Render cannot attach that disk to the replacement
instance while the old instance still owns it, so a deployment stops the old
T3 server before the new server can mount the disk and become ready. This is a
real outage, not only a dropped WebSocket: the custom domain and direct Render
origin return 502s, existing browser sessions disconnect, and Slack links cannot
open their central transcript during the gap. A 2026-08-31 UI deployment
produced roughly two and a half minutes of 502 responses before the replacement
started serving. Restarting the sole central process can also interrupt an
active provider turn.

Move the authoritative T3 persistence boundary to storage that does not require
exclusive attachment to one request-serving instance, most likely a Postgres
backend for T3's orchestration, projection, and browser-session repositories.
An equivalent design is acceptable only if it preserves central T3 as the one
canonical transcript and supports transactional ordering, idempotency, backup,
restore, and migration from the existing SQLite data. Splitting static assets
onto a CDN would keep the shell loadable but would not make conversations
available, so it does not close this TODO.

This TODO is complete only after `compadre-web` can run overlapping old and new
instances with graceful connection draining, a deploy can occur while a turn
is active without losing or duplicating it, and an automated canary observes no
HTTP 5xx or transcript unavailability throughout the rollout. Until then,
every T3 fork merge must be treated as a user-visible maintenance event and
verified after the replacement instance is live.

The controller is also kept at one instance today. Native T3 run execution,
events, dispatch metadata, driver-epoch fencing, and cancellation are durable
through Temporal, and a restart resumes active runs on the replacement
instance. Multi-instance operation additionally requires durable per-run
tool-bridge credentials (the relay tool bridge is still process-local) and
explicit write ownership for the worker-lifecycle sweep.

## Configuration

Controller:

```text
COMPADRE_T3_DIRECTORY_ENABLED=true
COMPADRE_T3_SLACK_ENABLED=true
COMPADRE_T3_API_ENABLED=true
COMPADRE_DURABILITY_BACKEND=postgres
COMPADRE_PUBLIC_URL=https://compadre-api.comprehensive.io
COMPADRE_T3_CENTRAL_URL=https://compadre.comprehensive.io
COMPADRE_T3_HOSTED_APP_URL=https://compadre.comprehensive.io
COMPADRE_T3_CENTRAL_TOKEN=<scoped T3 bearer>
COMPADRE_BACKUP_TOKEN=<random controller/T3 backup credential>
COMPADRE_SLACK_WORKSPACE_ID=<allowed Slack workspace ID>
SLACK_CLIENT_ID=<Sign in with Slack client ID>
SLACK_CLIENT_SECRET=<Sign in with Slack client secret>
SLACK_OIDC_REDIRECT_URI=https://compadre-api.comprehensive.io/auth/slack/callback
COMPADRE_AUTH_EXCHANGE_SECRET=<random shared controller/T3 credential>
COMPADRE_PREVIEW_HOST_SUFFIX=dev.compadre.comprehensive.io
COMPADRE_PREVIEW_GATEWAY_SECRET=<random preview resolver credential>
COMPADRE_T3_PACKAGE_URL=<pinned fork release>
COMPADRE_T3_PACKAGE_SHA256=<required digest>
COMPADRE_T3_ARTIFACT_BUCKET=compadre
COMPADRE_T3_ARTIFACT_REGION=us-west-2
COMPADRE_T3_WORKER_WARM_TTL_MS=1800000
COMPADRE_T3_WORKER_SWEEP_INTERVAL_MS=60000
COMPADRE_MODAL_TIMEOUT_MS=7200000
COMPADRE_MODAL_SNAPSHOT_TTL_MS=604800000
```

Slack thread history from before the bot mention is supplied as hidden context
only when a conversation is created, or for an explicit mention-only resumed
turn. Slack image inputs are downloaded with the bot credential and forwarded
to the native T3 harness without becoming a second transcript. Generated files
written under `/tmp/agent-outputs` are content-addressed into the private S3
bucket; Postgres retains their metadata, while authenticated controller reads
serve the central UI and the same bytes are uploaded to a linked Slack thread.

The Compadre T3 fork defaults `enableAgentBrowserAccess` to `false`. This is a
server-side provider boundary: workers do not mint the `t3-code` MCP credential,
attach the browser MCP server, or include `preview_*` tool descriptions in agent
prompts. The user-facing web application remains available; this setting only
removes agent control of T3's in-app preview browser.

Central T3:

```text
COMPADRE_NATIVE_T3_URL=https://compadre-api.comprehensive.io/hosted/t3/chat
COMPADRE_CONTROLLER_URL=https://compadre-api.comprehensive.io
COMPADRE_AUTH_EXCHANGE_SECRET=<same random controller/T3 credential>
COMPADRE_PREVIEW_HOST_SUFFIX=dev.compadre.comprehensive.io
COMPADRE_PREVIEW_GATEWAY_SECRET=<same preview resolver credential>
COMPADRE_AUTH_COOKIE_DOMAIN=.compadre.comprehensive.io
COMPADRE_BACKUP_TOKEN=<same random controller/T3 backup credential>
VITE_COMPADRE_AUTH_ENABLED=true
T3CODE_INSTALL_GH_CLI=true
GH_TOKEN=<repository-scoped token for T3 source-control UI>
COMPADRE_PROVIDER_URL=
```

Development previews use
`https://<canonical-thread-id>.dev.compadre.comprehensive.io`. The central T3
service validates its Slack-backed browser session before resolving the
thread's already-bound Modal sandbox through the controller. The controller
returns the raw port-3000 tunnel only to the central service. Comp's own
host-scoped session cookie is forwarded independently, preserving the dev-login
routes that select any user from the synthetic database.

`COMPADRE_PROVIDER_URL` belongs to the removed first-generation Compadre provider
and must stay unset. The supported architecture exposes native `codex` and
`claudeAgent` providers only.

## Security and retention

The controller authenticates service routes with scoped shared credentials and
browser users through Slack OIDC. Canonical users and workspace-scoped Slack
identities live in Postgres; central T3 sessions and message attribution are
persisted in SQLite. The current internal policy grants active members of the
allowed Slack workspace access to all conversations. Thread-level membership,
roles, and a complete administrative audit trail remain future hardening.

The system must never turn client-supplied or unverified Slack display names
into authorization data.

Conversation deletion must eventually propagate to central T3, Postgres recovery
records, Modal snapshots, provider-native transcripts, attachments, Slack where
appropriate, and Datadog according to its retention policy. Datadog content is
redacted and bounded, but it is still a retained copy and belongs in the data
inventory.

## Slack application

The checked-in [production Slack manifest](./slack-app-manifest.yaml) targets the
canonical controller hostname. It accepts direct-message and `app_mention`
events and dynamically resolves the installation-specific bot identity. The
temporary app manifest remains only as a record of the dark-launch installation.

The official `Compadre` app owns production Slack ingress for the allowed
Comprehensive workspace. Its event URL is
`https://compadre-api.comprehensive.io/slack/events`; Sign in with Slack uses
`https://compadre-api.comprehensive.io/auth/slack/callback`. The production
bot token, signing secret, client ID, and client secret belong only in the
`compadre-production-api` Render environment group; never copy them into
source, central T3, or Modal.

The temporary `Secret dre experiment` app remains only as an explicit
post-cutover cleanup/rollback decision. Do not route production traffic to it
or delete it without authorization.
