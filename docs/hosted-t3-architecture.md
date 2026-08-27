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

## Durable ownership

| Data | Owner |
| --- | --- |
| Conversation events, messages, tools, turns, approvals | Central T3 SQLite |
| External-thread binding, worker identity, lease and recovery metadata | Compadre Postgres |
| Checkout, live terminal, provider process and native transcript | Modal worker |
| Attachments and large artifacts | Central object storage |
| Logs, traces, model usage and cost telemetry | Datadog |

The current controller also stores the latest complete worker T3 snapshot in
Postgres. This is a transitional recovery record and duplicates conversation
text. Replace it with a narrow execution record after durable worker-event
delivery can reconstruct central T3 without the full snapshot.

## Worker event delivery

Today the controller projects worker T3 snapshots into an AG-UI-compatible SSE
stream and the central T3 remote-provider adapter converts that stream back into
T3 provider events. Text and named tool calls are supported. The production
hardening target is a versioned provider-event protocol with:

- Ordered sequence numbers and idempotency keys.
- A durable outbox and resumable delivery cursor.
- Usage and cost events.
- Approvals and user-input requests.
- Workspace diffs, checkpoints, attachments, and shell lifecycle.
- Explicit compatibility negotiation between controller and T3 fork versions.

## Usage

Native usage originates in the Modal worker. The worker exports model, provider,
token, tool, latency, and reported cost data to the single Datadog Agent
Observability application while keeping worker/controller APM services distinct.

Upstream T3's Usage page scans provider transcript files local to its server.
That is not correct for the hosted topology because transcripts live in Modal.
The worker-event protocol must publish normalized, idempotent usage records to a
central ledger; the T3 context indicator, usage dashboard, and Datadog export
should all project from those records.

## Deployment

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

The controller is also kept at one instance today because active tool bridges and
cancellation ownership are process-local. Multi-instance operation requires
Postgres leases, fencing tokens, heartbeats, and a durable command inbox so a
deploy cannot orphan an active Modal callback.

## Configuration

Controller:

```text
COMPADRE_T3_DIRECTORY_ENABLED=true
COMPADRE_T3_SLACK_ENABLED=true
COMPADRE_T3_API_ENABLED=true
COMPADRE_DURABILITY_BACKEND=postgres
COMPADRE_T3_CENTRAL_URL=https://t3code-compadre-experiment.onrender.com
COMPADRE_T3_CENTRAL_TOKEN=<scoped T3 bearer>
COMPADRE_T3_PACKAGE_URL=<pinned fork release>
COMPADRE_T3_PACKAGE_SHA256=<required digest>
```

Central T3:

```text
COMPADRE_NATIVE_T3_URL=https://compadre-t3-experiment.onrender.com/hosted/t3/chat
COMPADRE_PROVIDER_URL=
```

`COMPADRE_PROVIDER_URL` belongs to the removed first-generation Compadre provider
and must stay unset. The supported architecture exposes native `codex` and
`claudeAgent` providers only.

## Security and retention

The controller currently authenticates internal routes with a shared bearer.
Before expanding access, bind user and Slack workspace identities to thread
ownership, authorize every read and command, and record an audit event.

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
