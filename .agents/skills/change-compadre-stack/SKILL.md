---
name: change-compadre-stack
description: Implement, ship, and verify Compadre changes across the controller, hosted T3 fork, Modal workers, Slack/API entrypoints, Render, and Postgres or SQLite. Use for product UI, agent capability, protocol, database, infrastructure, configuration, deployment, architecture, security, identity, runbook, or durable documentation work. For diagnosing one failed Slack-to-Modal run, use debug-compadre-workflows instead.
---

# Change Compadre Stack

Use this skill to put a change at the correct architectural seam and carry it
through deployed verification. Compadre spans two repositories and three
runtime layers; a locally correct edit is incomplete if the corresponding
service, migration, worker, or entrypoint is not updated.

## Start with ownership

Before editing:

1. Read `CONTEXT.md` and `docs/hosted-t3-architecture.md` in the Compadre
   controller repository.
2. Read [references/stack-map.md](references/stack-map.md) and classify the
   change by data owner and runtime boundary.
3. Inspect the status and active worktrees of both repositories. Never mix a
   change into another agent's branch; create an isolated worktree from the
   intended base when needed.
4. In the Compadre repository, follow `AGENTS.md` and run the TanStack Intent
   skill discovery before substantial edits. In the T3 fork, read its complete
   `AGENTS.md` before acting.
5. Preserve the user's authorization boundary. Loading this skill does not
   authorize a merge, production mutation, Slack message, secret rotation, or
   destructive database operation.

The common local repositories are:

- Controller: `comprehensiveio/compadre`
- Hosted UI/server fork: `comprehensiveio/t3code` (often checked out locally
  as `t3code-experiment`)

Do not treat the controller repository's legacy `web/` directory as the
production UI. The production web application is the T3 fork.

## Route to the relevant guide

Read only the references needed for the current change:

- UI, central T3 server, auth/session, source-control UI, or fork maintenance:
  [references/ui-and-t3-fork.md](references/ui-and-t3-fork.md)
- MCP, tool, skill, prompt, CLI, provider, or Modal worker capability:
  [references/agent-capabilities.md](references/agent-capabilities.md)
- Any schema, persistence, backfill, retention, or migration change:
  [references/database-changes.md](references/database-changes.md)
- Any change that will merge, deploy, mutate production configuration, or
  requires end-to-end proof:
  [references/deploy-and-verify.md](references/deploy-and-verify.md)

For a cross-repository protocol change, read all of stack-map, the relevant
implementation guide, and deploy-and-verify. Keep the old protocol working
until both sides are deployed; do not make two independently auto-deploying
services require an atomic rollout.

## Preserve these invariants

- Central T3 SQLite owns the canonical conversation rendered by the web UI.
  Reading a completed thread must not wake Modal.
- Compadre Postgres owns control-plane state: canonical users and Slack
  identities, external bindings, run lifecycle/event delivery, worker
  identity, leases, recovery, and Slack delivery outbox records.
- One canonical thread maps to one isolated Modal worker/filesystem. Restoring
  a worker may change its sandbox ID or generation without changing the
  canonical or native T3 thread IDs.
- A terminal worker stays warm for its bounded lease, then the controller
  snapshots its stopped filesystem and records it as suspended. A later write
  restores a new sandbox generation; a central read must not wake it.
- Codex and Claude Code remain T3's native provider identities. Compadre is a
  transport/controller, not a model-picker option.
- Slack, browser, and compatibility API messages enter the same central T3
  thread. Do not create a second conversation store or direct Slack-to-worker
  path.
- The controller outbox is the sole automatic owner of final Slack delivery.
  Worker Slack tools must not produce a duplicate same-thread final response.
- Long-lived service, database, and private-network credentials and MCP clients
  stay on the controller. Modal receives only scoped, short-lived per-run
  material needed by that thread.
- The production controller and web services are single-writer deployments
  until their leases, fencing, and command-delivery boundaries say otherwise.

## Implement a vertical slice

Make one flow work end to end before broadening it:

1. Update the authoritative contract or schema.
2. Update the owning service and the narrow adapter at each crossed boundary.
3. Add focused tests for the observable behavior and failure mode.
4. Prove the flow locally or against safe real dependencies as appropriate.
5. Update the architecture, runbook, manifest, or skill whose current guidance
   would otherwise become false.
6. When authorized, merge through the repository's normal PR path, observe the
   correct auto-deployment, and verify the behavior on the far side.

Treat this skill as maintained architecture, not historical advice. If a
change makes any file path, ownership rule, safety boundary, deployment step,
or verification claim in this skill or its references verifiably incorrect,
update the affected guidance in the same change. Remove obsolete instructions
instead of layering exceptions on top. Do not edit guidance merely to match an
unmerged experiment; distinguish proposed behavior from deployed behavior and
refresh the skill when the proposal lands.

Do not claim completion from a source diff, green unit test, or queued Render
deploy. The finish line is the requested behavior on the intended entrypoint,
with the durable record and telemetry expected for that change.

## Leave evidence

Record enough evidence for the next operator to distinguish what was tested:

- commit/PR and deployed commit;
- service and instance that handled the proof;
- entrypoint, provider, model, and canonical thread/run identifiers where safe;
- migration or protocol version;
- expected durable owner and read path;
- relevant logs, trace, usage, or delivery result without prompts or secrets;
- known untested surfaces and rollback limits.

Keep incident-specific identifiers out of durable skills and architecture docs.
Put reusable failure modes and verification procedures there instead.
