# Temporal orchestration for native T3 runs

Compadre uses a self-hosted Temporal server as the durable orchestrator for
native T3 runs. The design goal is that no controller restart, deploy, or
transient Modal/network failure can orphan a run: every run either reaches a
genuine provider terminal or is converged to a terminal `failed`/`aborted`
record by a retried finalize step.

## Topology

| Piece | Where | Notes |
| --- | --- | --- |
| Temporal server | Render private service `compadre-temporal` (`temporalio/auto-setup`) | State in Render Postgres `compadre-temporal-db`; restarting the server pauses workflows, never loses them |
| Temporal worker | Inside the `compadre-api` process | Task queue `compadre-native-t3`, namespace `compadre` (auto-registered at startup) |
| Workflow code | `src/temporal/workflows.ts`, bundled at build time to `dist/temporal-workflow-bundle.js` | Deployed workflow code is frozen with the release |
| Activities | `src/temporal/activities.ts` → `src/t3/native-t3-run-driver.ts` | Run in the controller process with the configured gateway/durability singletons |
| Orchestrator selector | `NATIVE_T3_RUN_ORCHESTRATOR` in `src/temporal/mode.ts` | Code-level kill switch; `"in-process"` is the rollback path |

## Run lifecycle

1. `/hosted/t3/chat` persists the full run request in Postgres
   (`src/t3/run-request-store.ts`, metadata namespaces
   `compadre.t3.run-requests.v1` / `compadre.t3.run-dispatches.v1`), creates
   the run record, and starts `nativeT3RunWorkflow` with a deterministic
   workflow id (`compadre-t3-<sha256(runId)>`). Duplicate starts are no-ops.
2. `driveNativeT3RunActivity` (130 m start-to-close so one attempt can watch
   the worker's full ~2 h Modal lifetime, 2 m heartbeat timeout for fast
   dead-controller detection, 3 attempts) first claims the run's durable driver epoch (the same fencing
   in-process drivers use, so a retiring pre-Temporal controller and the
   activity can never both write one run's log), maintains the worker
   binding's active-run marker, dispatches the worker turn **at most once** —
   a durable dispatch record written immediately after `gateway.send` makes
   every retry reattach via `gateway.resumeTurn` instead of re-sending — and
   projects worker snapshots into the Postgres run event log. On retry the
   projector is rebuilt from the already-persisted chunks
   (`NativeT3SnapshotProjector.restore`), so subscribers never see duplicated
   events. Slack final delivery honors steer supersession
   (`dispatchWasSuperseded`), matching the in-process mirror.
3. Retry semantics are split by cost, deliberately: transient watch failures
   (worker reconnect, Modal blips, watch timeout) **throw** and are retried by
   Temporal; only a genuine provider terminal event or explicit cancellation
   terminalizes the run. The legacy in-process stream converted every
   exception into a terminal RUN_ERROR — that inversion is the main
   reliability change.
4. `finalizeNativeT3RunActivity` (5 attempts, non-cancellable scope) converges
   any run whose drive could not finish: appends a terminal RUN_ERROR, marks
   the record `failed`/`aborted`, closes the log, releases the worker into its
   warm lease (`gateway.releaseWorkerAfterRun`) so the hibernation sweep can
   reclaim it, and trims the persisted request's attachments.
5. Cancellation: `POST /hosted/t3/runs/:id/cancel` records durable cancel
   intent and cancels the workflow; the drive activity's cancellation signal
   interrupts the worker turn and terminalizes the run as `aborted`.
   A Temporal activity cancellation is deliberately NOT sufficient on its
   own: it also fires for attempt timeouts, retry supersession, and worker
   drain, so the driver interrupts the billed worker turn only when the run
   record carries `cancelRequested`. Any other cancellation is a silent
   handoff — the attempt stops watching and the next attempt (possibly on a
   replacement instance) reattaches.

Subscribers are unchanged: central T3 and replay clients tail the Postgres
event log over SSE with `Last-Event-ID` resume; producer relocation is
invisible to them.

## Local development

```bash
npm run temporal:up     # gRPC localhost:7243, UI http://localhost:8243
npm run dev
npm run temporal:probe  # end-to-end proof against the real local server
```

The probe (`scripts/probe-temporal-native-run.ts`) drives two scenarios through
the real server, worker, and HTTP route with a fake Modal gateway: a drive
attempt that dies mid-watch (asserting Temporal retries it, dispatch happens
exactly once, and the SSE stream contains no duplicated events) and a durable
cancellation. Run it after changing the workflow, activities, or driver.

The first use of a fresh namespace waits ~10 s for server-side namespace
propagation; later startups skip it.

## Deploy and operate

- `npm run build` compiles the server **and** the workflow bundle. A worker
  only loads `dist/temporal-workflow-bundle.js`; if it is missing (local tsx
  dev), it bundles the TypeScript source on demand.
- `compadre-api` startup fails fast when the Temporal server is unreachable,
  so a broken Temporal deployment blocks new controller versions from taking
  traffic instead of silently dropping runs.
- Shutdown drains the Temporal worker alongside HTTP
  (`TEMPORAL_SHUTDOWN_GRACE_TIME_MS`, default 280 s, below Render's 300 s
  cap). An activity that cannot finish in the window is retried by the
  replacement instance and resumes from the durable log — deploys during
  active runs are safe by design, which is why there is no deploy gate.
- Workflow-code changes must keep running histories replayable. Once
  production workflows exist, gate behavior changes in
  `src/temporal/workflows.ts` with `patched()` and keep the old path until the
  drain completes. Activities and the driver can change freely; they are not
  replayed.
- Temporal server upgrades: pin `temporalio/auto-setup` versions and upgrade
  the server before upgrading `@temporalio/*` SDKs.
- There is no production Temporal UI deployment yet. Use the local
  docker-compose UI against a production incident by reading state through the
  run records in Postgres first; add an authenticated UI service if operating
  blind becomes a real cost.

## Rollback

Set `NATIVE_T3_RUN_ORCHESTRATOR = "in-process"` in `src/temporal/mode.ts` and
deploy. The routes, durability contracts, and SSE surfaces are identical in
both modes; in-process mode restores the pre-Temporal behavior (runs are
fire-and-forget promises that do not survive restarts). Runs already owned by
Temporal at rollback time converge via their finalize activity as workers
drain.
