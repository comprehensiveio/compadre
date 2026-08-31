---
name: debug-compadre-workflows
description: Investigate and improve Compadre's Slack-to-Modal execution when agent runs stop, reset, time out, exhaust memory, fail to open PRs, or surface incomplete Slack responses. Use while developing or operating the Compadre repository, not as a skill executed by Compadre against customer application code.
---

# Debug Compadre Workflows

Trace failures across the complete execution boundary:

```text
Slack thread -> compadre-relay -> execution controller -> harness process tree
```

The persistent Render relay is the execution controller and supervises a
Modal sandbox. Correlate the Compadre run ID, Modal sandbox ID, and
host-tool bridge lifecycle. Native repository tools run in Modal; bridged MCP
and private-network tools still run in the relay.

Do not infer that the relay failed merely because Slack says a run stopped. The
relay can remain healthy while Modal provisioning, the harness process, or an
authenticated tool request fails.

## Correlate one run

1. Read the complete Slack thread. Record its channel ID, parent `threadTs`, run start time, failure time, and streaming message timestamp.
2. Search `compadre-relay` logs around that window using the Slack `threadTs`
   or run ID. Record sandbox creation, bridge registration, first-event, and
   terminal lifecycle messages.
   In Datadog, open the matching `compadre.agent.run` trace and compare its
   `compadre.agent.mcp.connect` and `compadre.agent.mcp.discover` children by
   `mcp.server.name`. Then inspect `compadre.agent.modal.image.resolve`,
   `sandbox.create`, `repository.clone`, `snapshot.resolve`, and
   `harness.spawn`. Long-running Modal harnesses also emit `[modal-process]`
   samples every 10 seconds with aggregate RSS and the largest process name;
   the completed `compadre.agent.modal.harness.run` span records peak RSS and
   the process exit code. The equivalent bounded relay evidence is emitted as
   `[mcp-timing]` and `[modal-timing]` logs.
   Native T3 workers additionally emit `[t3-worker-lifecycle]` events for
   `provision.completed`, `warm.started`, `hibernate.started`,
   `hibernate.recovered`, `hibernate.completed`, `hibernate.failed`,
   `restore.started`, `restore.completed`, and `restore.failed`. Correlate the
   generation and old versus new sandbox IDs; a restore intentionally creates a
   new sandbox. One `hibernate.failed` schedules a one-minute retry. Repeated
   failures leave the worker warm and billed, so alert on them rather than
   treating the retry as eventual success.
3. Inspect the matching Modal sandbox and audit log using its sandbox ID.
   Distinguish provisioning failure, setup failure, harness exit, controller
   cancellation, and destroy failure.
4. Check `[workflow-agent] run failed` for the bounded,
   environment-secret-redacted error message, stack, cause, elapsed time,
   provider, and repository revision.
5. For a tool failure, correlate the bridge ID and HTTP status without logging
   its bearer token, arguments, or result.
   If the bridge registers but receives no request, inspect whether the harness
   received an MCP server configuration and probe its complete per-run bridge
   URL from inside the sandbox without credentials. An HTTP 401 proves routing
   reached bridge authentication. Capture connection error details separately
   when investigating DNS, TLS, tunnel, or egress failures; treat other HTTP
   statuses as route or upstream responses before bearer validation.
   For local Cloudflare quick-tunnel probes, start `cloudflared` with an empty
   config (`--config /dev/null`) and verify the issued hostname's `/health`
   returns 200 before launching a run. Otherwise a local named-tunnel config can
   silently capture the command and make every bridge path return 404.
6. Correlate deploys or configuration changes only after identifying which
   boundary failed.

Prefer exact identifiers and narrow time windows. Render service instance suffixes such as `web-8cv7x` are ephemeral; use the stable host/service identity and discovered IDs instead of copying an old suffix.

## Interpret the evidence

- For Modal, distinguish controller failure, sandbox lifecycle failure,
  harness command exit, and authenticated host-tool bridge failure. A tool
  bridge error does not prove that the sandbox or private service failed.
- MCP clients connect and discover tools concurrently. Use the parent span or
  measure from the earliest child start to the latest child end; do not add
  child durations together.
  Likewise, attribute only measured Modal child spans to provisioning. The
  remainder before `wait.first_event` belongs to unmeasured adapter/provider
  startup, not automatically to Modal.
- Modal's JS SDK exposes exec stdin, but Compadre deliberately advertises it as
  non-writable: a persistent-shell probe showed writes can remain buffered with
  no sentinel output. TanStack therefore uses its exec/file-backed path.
- A caught harness error should produce `[workflow-agent] run failed`. Its
  absence does not prove success: sandbox termination can bypass JavaScript
  cleanup.
- A Slack response that stops changing is not necessarily a failed run. Check
  whether `[modal-process]` samples continue and whether the sandbox still
  polls as active. Sustained `tsc` or build RSS/CPU proves only that work is
  active and can also indicate a stuck or runaway process. Require repeated
  samples plus completion, process exit, or sandbox-lifecycle evidence before
  declaring validation successful.
- A central T3 thread that shows only pre-tool narration may have completed
  successfully in its Modal worker. Native T3 providers can emit multiple
  assistant messages in one turn (narration, an intermediate update, then the
  final answer). Compare the hosted T3 message projection with the archived
  `compadre.t3.thread-snapshots.v1` worker snapshot before diagnosing an early
  harness exit; fewer central messages indicates a projection loss rather than
  missing provider output.
- A native provider can fail before T3 assigns a turn. The requested user's
  `turnId` remains null, while `latestTurn` is either null or still refers to a
  prior turn, even though the session is stopped or errored. Treat a current
  `provider.turn.start.failed` or `runtime.error` activity plus
  `session.lastError` as terminal evidence; do not keep polling for a turn ID.
  Correlate the activity timestamp to the requested message so an older stopped
  session is not mistaken for the new request's outcome.
- A Claude turn that is assigned and then immediately reaches `latestTurn.state
  = error` with `Claude runtime stream failed` has crossed the pre-turn boundary.
  Inspect the sandbox for the presence (never the value) of
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, then run `claude auth
  status`. Missing projected credentials together with `loggedIn: false` is an
  authentication failure, not a permission-mode or central projection failure.
  If credentials are present and a direct Claude CLI request succeeds,
  reproduce the failure with T3's Agent SDK options. Claude rejects
  `--dangerously-skip-permissions` under root; Compadre's root-hosted workers
  must use T3's root-safe full-access mapping rather than treating that error
  as an authentication failure.
- A Render cutover can briefly return a non-JSON 502 for an otherwise healthy
  central T3 thread snapshot while the provider turn finishes successfully.
  Correlate the request failure with deploy lifecycle and T3 turn completion;
  Compadre retries transient idempotent T3 reads (including startup and thread
  snapshots) after transport, timeout, and HTTP 500-504 failures for a bounded
  window rather than canceling the run immediately.
- In central-native mode, Slack ingress must first create or continue the
  hosted Render T3 thread; the central T3 provider callback then invokes the
  Compadre/Modal worker. Correlate the Slack channel/thread with the stable
  central T3 thread id, then the Compadre binding and Modal sandbox. A direct
  Slack-to-worker dispatch bypasses the authoritative UI event log and is a
  routing defect, even when Slack receives a valid answer.
- Central T3 message ids marked `slack-entrypoint:` suppress the reverse
  web-to-Slack mirror for that turn. If a Slack prompt is delivered twice,
  verify that the marker survived T3 orchestration into the Compadre provider
  request before diagnosing Slack retries or event deduplication.
- Slack automatically removes an `assistant.threads.setStatus` indicator after
  two minutes if the app has not sent a message. This can make a healthy
  pre-text tool run look abandoned even though no native `chat.startStream`
  exists yet. Compadre refreshes the current thread status inside that window;
  diagnose status expiry separately from native response-stream expiry.
- A `compadre-thinking` reaction's age does not prove its run was interrupted.
  Slack reaction recovery must correlate the message to the durable run ID and
  reconcile from its lifecycle status. For a false `compadre-failure` marker,
  confirm the run is still `running` or `interrupted` before restoring the
  thinking reaction.
- Modal process-tree RSS approaching the configured memory limit immediately
  before a sandbox `WaitPID` EOF strongly supports a sandbox OOM, even when the
  terminal error is only exit 128 rather than an explicit OOM label.
- Compadre does not impose a wall-clock agent deadline. Compare observed
  duration with explicit caller cancellation and the configured Modal sandbox
  lifetime before calling a failure a timeout.
- A native worker that disappears after a completed turn may be intentionally
  suspended, not expired. Check the binding's `workerState`, `warmUntil`, and
  `workerSnapshotId`. A later message should transition `suspended ->
restoring -> running`; preview resolution alone intentionally does not wake
  it. Snapshot expiry is distinct from the two-hour live sandbox timeout.
- `message_not_in_streaming_state` means Slack closed that native delivery
  stream; it does not establish whether the agent succeeded, failed, or is
  still running. Correlate the harness and workflow terminal evidence.
- Slack can close a quiet native agent stream after an undocumented timeout.
  Compadre sends invisible keepalives while no text is arriving; if Slack still
  reports `message_not_in_streaming_state`, it rotates the unsent suffix into a
  fresh native stream. Treat an editable-message recovery as the final fallback,
  not the normal continuation path.
- A database connection/disconnection log containing the word `compadre` is not necessarily an agent-run log. Confirm host, service, run ID, and time.

When evidence cannot distinguish OOM, platform termination, and harness exit, say exactly which signals are missing. Do not upgrade timing coincidence into certainty.

## Preserve diagnosability

Keep diagnostic logs structured, bounded, and free of prompts, message bodies, credentials, command arguments, and tool output. Process names from `comm` are acceptable; full `args` are not. Prefer existing telemetry and process observers over adding overlapping timers.

When changing this execution path, verify the TypeScript build, targeted tests
for the touched boundary, and the full test suite. Confirm that hard-kill paths
still leave useful evidence outside the killed process, usually relay lifecycle
logs and Modal audit metadata.

## Keep this skill current

Treat this as a living developer runbook. If an investigation teaches you a reusable query, identifier mapping, failure mode, misleading symptom, observability gap, or correction, update this skill in the same change when doing so is in scope. Remove or revise stale guidance rather than accumulating contradictory notes. Do not add incident-specific user content, secrets, volatile instance IDs, or conclusions that are not supported by repeatable evidence.
