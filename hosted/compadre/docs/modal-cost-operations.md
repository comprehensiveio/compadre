# Modal cost operations

Compadre uses standard Modal Sandboxes. The current code does not enable
Modal's experimental VM Sandbox runtime. The guest still looks like an Ubuntu
container, while Modal supplies the isolation, scheduling, encrypted tunnels,
remote execution, resource accounting, and lifecycle control plane.

## Current cost controls

- CPU and memory requests default to 0.5 core and 2 GiB (production requests
  2 cores and 16 GiB). Modal charges the greater of requested and actual
  usage, so these requests define the idle floor; configured burst limits are
  not automatically billed at their maximum.
- A worker sandbox lives for its whole configured lifetime (two hours by
  default) whether or not a turn is active — reliability is prioritized over
  idle compute cost. At Modal's published September 2026 Sandbox rates, the
  production request is roughly $0.67 per worker-hour (about $1.34 for a full
  two-hour lifetime) before network, snapshot storage, regional multipliers, or
  usage above the request.
- After every terminal turn the worker's filesystem is checkpointed live (no
  quiesce, no termination). Checkpoint images expire after seven days by
  default.

Pricing changes; verify current rates in Modal's pricing and Sandbox resource
documentation before using these estimates for a budget.

The `Codex auth routing initialized` startup log records the effective
`modalTimeoutMs`. Check that field when production might override the shared
two-hour code default; do not infer the deployed value from `.env.example`.

## Attribution and alerts

Every newly created or restored sandbox is tagged with `managedBy`,
`environment`, `purpose`, `provider`, `devEnvironment`, `workerGeneration`, and
a truncated SHA-256 hash as `threadKey`. It does not embed the raw Slack or
thread identifier, but it remains linkable by anyone holding a candidate value;
use a secret salt if operational requirements demand unlinkability. Do not put
raw Slack or thread identifiers into Modal tags.

The controller emits a lifecycle transition counter through OpenTelemetry and
structured `t3 worker lifecycle` logs. Verify metric ingestion before creating
metric-based monitors; declaring a counter does not configure a metrics exporter.
The structured logs also work through the Render log drain. Useful initial monitors are:

- any live duration approaching `COMPADRE_MODAL_TIMEOUT_MS`;
- repeated `checkpoint.failed` or `restore.failed` transitions;
- active sandbox count and worker-hours grouped by environment, provider, and
  dev-environment tag;
- checkpoint restore failures before the seven-day retention boundary.

If sandbox worker-hours become a cost problem, add a boring garbage-collection
pass for long-idle workers — do not reintroduce per-run lifecycle management.
Avoid increasing CPU or memory requests to address rare bursts: first inspect
actual usage, then change the request only when the sustained workload needs it.

## Preview startup measurements

Preview activation records retain `requestedAt` through activity retries and
controller restarts. Existing records without it remain valid, but do not emit
a fabricated total duration. The controller emits these single-line JSON events:

| Event | What it measures |
| --- | --- |
| `preview.activation.requested` | One activation accepted, identified by `activationId` and `canonicalThreadId`. Refreshes reuse an in-flight activation. |
| `preview.activation.attempt` | A Temporal activity attempt starts; `activityAttempt` distinguishes retries. |
| `preview.activation.transition` | `previousPhase`, new `phase`, `phaseDurationMs`, and cumulative `elapsedMs` since the accepted request. Terminal phases are `ready` and `failed`. |
| `preview.worker.connected` | `workerMode` is `reconnected` or `restored`; includes the resulting `sandboxId`. |
| `modal.phase.completed` | Low-level Modal operation, `outcome`, and `elapsedMs`; preview operations inherit the activation ID and activity attempt. |
| `modal.sandbox.created` | Sandbox ID, effective resource requests/limits, hard timeout, and cost tags for both fresh and restored sandboxes. |

`requested → restoring` includes workflow scheduling and waiting for the shared
thread lock. `restoring → starting` includes reconnect or filesystem restoration,
credential projection and worker T3 readiness. `starting → ready` includes tunnel
setup and the development-stack startup command. Retry backoff remains in the
cumulative total; individual phase intervals can include backoff. Repeated updates
to the same phase preserve the original phase start. Terminal redeliveries and
updates from superseded activations do not emit another outcome.

These are **server activation timings**, not browser navigation or first-render
timings. `ready` means the development startup command succeeded, before the
browser reload and subsequent application requests. Warm visits that do not
activate the worker are not in this population. A completed worker restore alone
also excludes the later development-stack startup. Do not report either as
end-to-end preview latency.

In Datadog Logs, discover the service's actual log-drain attributes first: Render
can use an instance name as `service`, rather than `compadre-api`. Search
`@event:preview.activation.transition` and scope to the controller's source.
For an `analyze_datadog_logs` query, declare `@phase` and `@previousPhase` as
`varchar`, and `@elapsedMs` / `@phaseDurationMs` as `bigint`:

```sql
SELECT "@phase", COUNT(*) AS outcomes,
       APPROX_PERCENTILE(0.5) WITHIN GROUP (ORDER BY "@elapsedMs") AS p50_ms,
       APPROX_PERCENTILE(0.95) WITHIN GROUP (ORDER BY "@elapsedMs") AS p95_ms
FROM logs
WHERE "@phase" IN ('ready', 'failed') AND "@elapsedMs" IS NOT NULL
GROUP BY "@phase"
```

Break down phase duration by `@previousPhase`; filter one activation ID to inspect
retries and lower-level operations. Logs are diagnostic telemetry, not an
exactly-once billing ledger: process loss between persistence and logging can
omit a transition. The latest activation remains in controller metadata; historical
outcomes follow Datadog log retention.

## Cost decisions

Use `modal billing summary` for the workspace total and the resource report for
CPU/memory attribution. Reports cover complete intervals and can lag the summary.
Request `--tag-names purpose,devEnvironment,environment` when supported; verify
that the returned tags are populated before treating them as a spend breakdown.
Sandbox tags and a `devEnvironment` configuration flag do not prove a dev server
was running or receiving traffic.

At a 2-core / 16-GiB request and the published September 2026 Sandbox rates,
two hours cost approximately $1.34 and 24 hours approximately $16.03 per worker
before additional charges. Extending an otherwise-expiring worker by 22 hours
therefore adds approximately $14.70 if it remains alive throughout. This is a
per-worker scenario, not a forecast of the whole bill: restores and manual
termination change the number of lifetimes purchased.

Before changing the retention policy, measure active-turn time, actual preview
traffic and time since the last visit, idle worker-hours, CPU/memory usage and
pressure, and exit reasons. Existing lifecycle logs do not record every Modal
expiry at its actual time; `worker.lost` is detection, not a billing stop event.
Use Modal billing/inventory as the authority for billed lifetime and reconcile
it with controller activity. Lower requests need workload trials because
monorepo checks previously starved the worker T3 server and exhausted memory.
Do not terminate a worker merely because port 3000 is stopped: it may be running
an agent, a terminal job, or work awaiting input. Any idle collection policy must
share the thread lock, retain a usable checkpoint, and recheck activity before
termination.

## Investigating a spend-limit outage

Modal rejects new sandbox creation with `RESOURCE_EXHAUSTED` and `has exceeded
its spend limit` after the workspace budget is consumed. That phrase means a
billing limit, not CPU, memory, or container concurrency exhaustion. A Modal
workspace Owner or Manager must raise or reset the spend limit on Usage &
Billing before new Compadre workers can start.

Use Modal's read-only billing and inventory commands to establish the cause and
the current blast radius:

```bash
modal billing summary --for "this month"
modal billing report --for "this month" -r d --show-resources
modal container list --app-id <resolved-compadre-app-id> --json
```

Resolve the `compadre` app in the Comprehensive workspace; never copy an app ID
from another environment. If live sandboxes exist, correlate their Compadre
tags and controller binding/run state before terminating anything. A sandbox
that owns an active turn must not be treated as idle. If the inventory is
already empty, there is nothing to terminate: use the billing report and
creation/termination telemetry to diagnose accumulated worker-hours instead.

Sources: [Modal pricing](https://modal.com/pricing), [Sandbox resource and
billing behavior](https://modal.com/docs/guide/sandbox-resources), and
[filesystem snapshots](https://modal.com/docs/guide/sandbox-snapshots).

Run the predeployment gates in
[`modal-lifecycle-testing.md`](./modal-lifecycle-testing.md) before changing
timeout, snapshot, or resource settings.

## Browser collection through the preview gateway

The hosted web service injects a small script into authenticated HTML document
responses at the preview proxy. This covers existing workers without modifying
their repositories. Injection preserves streaming, stops looking for a head after
64 KiB, and does not change the application's content security policy. Pages whose
CSP blocks the script, non-HTML responses, and tabs loaded before deployment are
coverage gaps. HTML documents are served without conditional cache validation so
new navigations receive the collector. Set `COMPADRE_PREVIEW_TELEMETRY_ENABLED=false`
on the web service to stop injection and discard new reports.

`/.compadre/preview/telemetry.js` and the POST collector at
`/.compadre/preview/telemetry` terminate on the authenticated central server,
**before worker resolution**. Beacons never activate a worker or renew its lifetime.
Reports are bounded to 8 KiB, validated against fixed labels and numeric ranges,
and emitted as single-line JSON with `event=compadre.preview.browser`. The server
adds canonical thread ID, authenticated actor ID and receive time. The client adds
per-tab/per-page IDs and the previous page ID, without URLs, query strings,
resource names, request bodies, DOM content, or keystrokes.

Events cover navigation, DOM ready, window load, the app's existing
`app-data-ready` signal, activation completion/failure, page exit, visibility,
and Vite's public reconnect/full-reload hooks. Vite hooks attach after DOM ready;
very early disconnects may be missed. A navigation's `previousReason` is an
observed precursor from the previous 15 seconds, **not proof of causation**.
`wasDiscarded` helps distinguish browser tab discard from server-triggered reload.
Applications without the `app-data-ready` event still report navigation/resources,
but do not report application readiness.

Visible tabs send a heartbeat once per minute. `interactionCount` and
`interactionAgeMs` distinguish trusted pointer/key/scroll activity from a merely
visible tab. No key values are recorded. Visibility and heartbeats alone are not
proof that a worker must remain alive, and lack of reports is not permission to
terminate it. Browser telemetry is best-effort and untrusted diagnostic input.

Resource counts, transfer bytes, total resource duration, maximum resource
duration and API/module counts are **cumulative per page**, excluding the
collector's own requests. Resource durations overlap: their sum is not elapsed
load time. Use the latest observation per page, not a sum across heartbeats.

For the first few days, compare:

- `app_ready.elapsedMs` distributions, grouped by whether the previous page was
  an activation; report missing readiness and early page exits separately.
- Activation request-to-ready totals and controller phase timings against browser
  navigation-to-ready. Join by canonical thread and time; page IDs connect the
  interstitial and app navigation, while activation IDs identify controller retries.
- Navigation type, previous reason, discarded-tab flag and Vite events around
  unexpected reloads. Separate automatic activation reloads from other reloads.
- Resource counts/max duration versus API time on slow pages.
- Visible-preview minutes and recent-interaction minutes against Modal's actual
  billed worker-hours and resource charges. Compare browser activity with active
  agent/terminal work before calling unused time recoverable savings.

The collector is provider-independent and applies only to hosted preview web
pages, including pages opened from Slack or any Compadre client. It does not alter
local app browsing, native client contracts, worker lifetime, or shutdown policy.
