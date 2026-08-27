# Old Compadre parity audit

This document records which legacy Compadre behaviors exist in the hosted T3
architecture. It complements the production cutover checklist: this file
describes the capability gaps; the checklist describes the proof required to
ship them.

## Working architecture

| Capability | Status | Notes |
| --- | --- | --- |
| Central durable transcript | Proven | Central T3 SQLite renders completed threads without waking Modal. |
| Slack, browser, and relay API share a thread | Proven | All three entrypoints resolve to the central T3 thread ID. |
| Per-thread isolated execution | Proven | Every thread is bound to its own Modal worker and checkout. |
| Native Codex and Claude harnesses | Proven | T3 provider identities and model picker are retained; execution is remote. |
| Cross-entrypoint resume | Proven, needs stress testing | Browser and Slack can add turns to the same transcript. |
| Canonical users and message origin | Proven | Slack and web messages are stamped with canonical identity and origin. |
| Temporary Slack app identity and delivery | Proven | A deployed instance authenticated as `Secret dre experiment` and posted progress, one final answer, and one Open in web link under that identity. |
| MCP/custom-tool bridge | Implemented, incompletely proven | Shared controller configuration is exposed to both harnesses. |
| Datadog LLM Observability and OTEL | Implemented, needs production proof | One logical LLM application; separate distributed APM services. |
| Legacy HTTP execution surfaces | Proven live, needs caller soak | On 2026-08-27, `/prompt`, `/webhook/:source`, `/ag-ui`, and `/workflow-runs` all completed against deployed commit `d44982f`. PostgreSQL stores only the compatibility run/event projection. |

## Missing or incomplete parity

| Capability | Gap | Required direction |
| --- | --- | --- |
| Slack attachments | The legacy path passes Slack files into a run; the native T3 path currently drops them. | Persist attachment metadata centrally, authorize retrieval, and mount or fetch files in the worker. |
| Incomplete-answer continuation | Legacy Slack retries once when a run exits without a terminal answer. Native T3 does not. | Add one bounded, idempotent continuation with a visible terminal failure. |
| Slack answer ownership | Ordinary output is streamed automatically, but the harness can also call a Slack tool and duplicate the answer. | Suppress or deduplicate same-thread final delivery structurally; do not rely only on prompting. |
| Active runs during deploy | Central T3 shutdown currently cancels active remote-provider turns. | Drain or detach active runs and reconnect from the durable event cursor after restart. |
| Relay result semantics | `/prompt` now has durable asynchronous status/events, but synchronous token/cost fields are intentionally `null` until central usage accounting exists. | Add central usage records, then populate these fields from authoritative data. |
| Legacy workflow attachments | Text-only workflow runs migrate to central T3; old `inputFiles` requests return `409` instead of silently dropping bytes. | Port authorized attachment storage and worker materialization before accepting these requests. |
| Usage and cost | Provider transcripts and Datadog hold data, but central T3 has no normalized ledger. | Add idempotent usage events and make UI/context/cost projections consume them. |
| Rich provider protocol | Version 1 carries text and named tools only. | Add approvals, user input, diffs, checkpoints, attachments, shell lifecycle, and structured usage. |
| Restart takeover | A controller restart can replay events but cannot reattach and continue projection. | Persist dispatch/heartbeat state and later add leases and epoch fencing if reliability requires it. |
| Existing-thread provider changes | Legacy Compadre could reconstruct neutral context after a provider switch; hosted T3 currently fixes Codex vs. Claude after a thread's first turn. | Decide whether provider switching is required, then support it without losing the thread's central transcript or isolated filesystem. |
| Slack channel metadata | The temporary app can execute messages, but `conversations.info` currently falls back after `missing_scope`. | Reconcile the manifest's channel/DM read scopes and prove context loading in every supported conversation type. |
| Cancellation stream terminal event | Cancellation reaches central T3 and the durable run becomes `aborted`, but the compatibility SSE log currently closes without adding a synthetic terminal AG-UI chunk. | Decide on the legacy wire expectation and add an explicit aborted event for stream-only consumers if required. |
| Cold-start tail latency | Sequential live API probes varied from about one minute to more than three minutes; two concurrent cold threads took substantially longer during repository/bootstrap setup. | Instrument every post-clone bootstrap phase, establish SLOs, and prewarm or cache the expensive setup before cutover. |

## Legacy surface requiring a caller decision

The August 2026 repository inventory found one checked-in `/prompt` caller in
`comprehensiveio/comp`; it sends asynchronous requests and only depends on a
successful HTTP status. No checked-in `/ag-ui` or `/workflow-runs` callers were
found. Webhook callers may be configured outside source control, so the route
is retained and idempotent when callers supply `Idempotency-Key`.

Before deleting the compatibility facades, inventory real callers and owners for:

- `/prompt`, including synchronous clients outside the checked-in Comp app.
- `/webhook/:source` integrations.
- `/ag-ui` GET/POST consumers.
- `/workflow-runs`, status, event-stream, and cancellation consumers.
- Custom CLIs, deployment alerts, PR helpers, database tools, skills, prompts,
  and provider credentials used by either harness.

A capability may be deliberately retired, but retirement needs an owner, a
replacement or migration note, and an observation period proving that no live
caller depends on it. These compatibility routes must never grow a second
conversation store: central T3 owns messages and tool history; PostgreSQL owns
only run lifecycle, idempotency, replay cursors, and cancellation intent.

## Live compatibility proof

The deployed `d44982f` verification used the real bearer-authenticated routes,
central T3 service, PostgreSQL durability, Modal workers, and Codex harness:

- Synchronous `/prompt` returned `LEGACY_SYNC_OK`, the central thread link, and
  the selected `gpt-5.6-sol` model.
- Asynchronous `/prompt` returned `accepted`; repeating its `runId` returned
  `already accepted`; status reached `completed`; replay contained ordered
  start, text, and finish events with `LEGACY_ASYNC_OK`.
- Direct `/workflow-runs` reached `completed` and replayed
  `LEGACY_WORKFLOW_OK` with the same ordered event sequence.
- `/webhook/live-verification` deduplicated a repeated `Idempotency-Key`, then
  a sequential probe reached `completed` and replayed `LEGACY_WEBHOOK_OK`.
- `/ag-ui` accepted a standards-shaped `RunAgentInput` and streamed
  `RUN_STARTED`, text start/content/end, and `RUN_FINISHED` with
  `LEGACY_AGUI_OK`.
- A live cancellation returned the legacy `status: "cancelling"` response and
  the durable run then reached `aborted` with cancellation intent recorded.
