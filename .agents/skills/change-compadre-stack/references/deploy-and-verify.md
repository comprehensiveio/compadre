# Deploy and verify

Use this reference whenever a Compadre change is expected to reach a deployed
environment.

## Repository-to-service fanout

| Merge | What redeploys | Domain | What does not redeploy |
| --- | --- | --- | --- |
| `comprehensiveio/compadre` `main` | Render `compadre-api` controller | `compadre-api.comprehensive.io` | central T3 web and already-running worker files |
| `comprehensiveio/t3code` `main` | Render `compadre-web` T3 server/UI | `compadre.comprehensive.io` | controller and already-running worker files |

Per-thread Modal workers are lazy runtime resources. Controller changes affect
new requests after the API rollout; baked image/skill/T3-package changes may
require a new or restored worker generation before they are observable.

## Before merge

1. Work on an isolated branch/worktree from the intended base.
2. Preserve unrelated user and agent work.
3. Run focused tests as the change is built, then the repository-required
   typecheck/persistence/migration gates.
4. Update the relevant architecture, runbook, manifest, and this skill whenever
   the change makes existing guidance inaccurate.
5. Create/merge a PR only when the user's request authorizes it. Address
   concrete review findings against current code.

For cross-repository changes, keep each PR independently deployable and state
the safe order. Deploy tolerant consumers before new producers.

## Render safety

Always resolve the Comprehensive workspace before mutating:
`tea-ci5g47tgkuvgpf98aimg`.

Use Render CLI/API programmatically where possible. Discover current service
IDs rather than copying one from an unrelated workspace. Never infer ownership
from a service name, and never touch Tolt resources.

Keep `compadre-api` single-instance while its active tool bridge contains
process-local closures. Before increasing replicas, implement and prove either
instance-affine bridge routing or a durable tool dispatcher. Verify the actual
Render replica/routing topology before declaring a controller rollout safe.

Do not report a queued or `build_in_progress` deploy as deployed. Wait for the
specific commit's deploy to reach `live`, then check:

- API: `GET https://compadre-api.comprehensive.io/health`
- Web: `GET https://compadre.comprehensive.io/` plus an authenticated
  application flow
- startup logs for expected database migration, Slack identity, dependency,
  and protocol configuration
- the exact deployed commit and active instance

### Old-instance drain

`compadre-api` has a five-minute maximum shutdown delay. During a Render
rollout, the old and new instances can overlap. An old controller can still
claim a newly inserted Slack-delivery outbox record, making a canary appear to
use old code after the new deploy is marked `live`.

For behavior that is evaluated at completion:

1. record the new instance label from its startup log;
2. either wait until the old instance's drain window ends or prove the old
   instance is gone;
3. correlate the completion/delivery log's Render `instance` label with the
   new instance;
4. rerun a canary if the old instance won the delivery lease.

Do not “fix” correct source code because a draining old instance produced one
stale result.

## Verification by change type

### UI or central T3

- Open an authenticated existing thread and confirm it renders from central
  storage without Modal.
- Exercise the changed state and a new message.
- Check reload, empty/loading/error state, attribution, and Slack-linked
  behavior when relevant.
- Confirm the central server and WebSocket/event projection, not only static
  assets.

Use programmatic tests first. Use agent-browser or computer use only when the
task/user allows it and the visual behavior cannot be proved otherwise.

### Slack

Use the official app in `#slack-bot-test` for production canaries only when
authorized. Prefer a short, exact-output request.

Verify:

- the expected official bot identity;
- useful status/tool updates;
- exactly one final answer plus one canonical Compadre web link;
- central snapshot state is terminal and contains the final response;
- link returns the correct authenticated thread;
- no duplicate mirror/final delivery;
- the legacy relay received no `/slack/events` traffic;
- the delivery log came from the intended Render instance.

### Compatibility API

- authenticate with the real compatibility credential without printing it;
- use a unique run/idempotency key;
- verify accepted/duplicate semantics, ordered replay, terminal status,
  cancellation if changed, and the canonical web thread;
- confirm the result is stored centrally and does not create a parallel
  transcript.

### Agent capability or Modal worker

- start a fresh canonical thread/worker when the image or projected setup
  changed;
- verify the intended provider and model;
- invoke the actual MCP/tool/skill/CLI rather than only listing it;
- confirm tool name, arguments/result summary, and terminal state in central
  T3;
- verify Slack status/final behavior if Slack is in scope;
- repeat for Codex and Claude before claiming provider parity;
- run the applicable focused lifecycle gates in
  `docs/modal-lifecycle-testing.md` and prove the capability is reprojected
  after hibernation and restore.

For changes to worker failure handling, bridge locality, or recovery, also run
the relevant destructive canaries from `docs/modal-harness-cutover.md`:

- prove a Postgres-backed tool connection originates on Render, not Modal;
- force sandbox deletion during a run; and
- restart the controller during a run.

Each canary must end in a terminal durable event and the correct final Slack
state. Controller-restart takeover is supported for native provider turns: the
replacement must reproject the existing worker's narration and detailed tools
without sending a second provider request, and stale driver writes must be
rejected by the durable epoch fence. The replacement must log a provider-run
reconciliation correlated to the canary's canonical thread and `activeRunId`;
then verify the durable run's driver epoch advanced. The aggregate `resumed`
count is not canary evidence, and a missing correlated record fails this gate.
Do not rely only on a browser reconnect to trigger takeover.

### Database migration

Follow database-changes, then verify startup migration logs, old-data reads,
new writes, reload/restart behavior, backup health, and compatibility with the
rollback binary.

### Telemetry or LLM behavior

Datadog should show one logical `compadre` LLM application while
`compadre-api`, `compadre-web`, and worker execution remain distinguishable
APM services. Verify exact model, provider, origin, initiating user, tokens,
cost, input/output policy, trace relationships, and latency spans appropriate
to the change.

## Rollback and cleanup

- Keep schema changes forward-compatible; application rollback does not undo a
  migration.
- Do not delete Render services, Slack apps, disks, snapshots, buckets, or
  legacy rollback resources without explicit authorization.
- Do not preserve a failing canary as “proof.” Record the cause, correct it,
  deploy again, and capture terminal evidence from the corrected version.
- Remove temporary local harnesses and secret-bearing files. Keep durable tests
  and reusable runbook improvements.

The legacy relay and temporary Slack app are deliberate rollback/cleanup
decisions, not resources to remove opportunistically.
