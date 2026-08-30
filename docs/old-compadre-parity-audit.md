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
| Official Slack app identity and delivery | Proven live | The official `Compadre` app owns production events, shows active tools as Slack status, withholds web-only narration, and posts exactly one final answer plus one canonical Open in web link. A clean redeploy proved that its credentials come from the canonical Render env group rather than service overrides. |
| MCP/custom-tool bridge | Implemented, incompletely proven | Shared controller configuration is exposed to both harnesses. |
| Datadog LLM Observability and OTEL | Proven live | One logical `compadre` LLM application; separate `compadre-api`, `compadre-web`, and `compadre-worker` APM services. A production Slack canary recorded exact input/output content, model, token usage, canonical user, and Slack origin. |
| Legacy HTTP execution surfaces | Proven live, needs caller soak | On 2026-08-27, `/prompt`, `/webhook/:source`, `/ag-ui`, and `/workflow-runs` all completed against deployed commit `d44982f`. PostgreSQL stores only the compatibility run/event projection. |

## Missing or incomplete parity

| Capability | Gap | Required direction |
| --- | --- | --- |
| Slack attachments | Proven live for Codex; explicit Claude parity remains | A deployed Slack image canary reached the isolated worker and returned `IMAGE_INPUT_E2E_OK`. Repeat the same input test with Claude before claiming provider-wide parity. |
| Incomplete-answer continuation | Legacy Slack retries once when a run exits without a terminal answer. Native T3 does not. | Add one bounded, idempotent continuation with a visible terminal failure. |
| Slack answer ownership | Proven live | The durable controller outbox is the single automatic owner. Destination-scoped worker credentials structurally reject a same-thread `slack_reply_to_thread` call, while prompt instructions remain defense in depth. A live canary produced exactly one final answer and one web link, and a direct bridge probe produced no Slack side effect. |
| Active runs during deploy | Central T3 shutdown currently cancels active remote-provider turns. | Drain or detach active runs and reconnect from the durable event cursor after restart. |
| Relay result semantics | `/prompt` now has durable asynchronous status/events, but synchronous token/cost fields are intentionally `null` until central usage accounting exists. | Add central usage records, then populate these fields from authoritative data. |
| Legacy workflow attachments | Text-only workflow runs migrate to central T3; old `inputFiles` requests return `409` instead of silently dropping bytes. | Port authorized attachment storage and worker materialization before accepting these requests. |
| Usage and cost | Proven | Central T3 stores idempotent provider-usage records with tokens, model, initiating user, origin, and computed cost; the Usage UI and Datadog consume the resulting projection. |
| Rich provider protocol | Version 1 carries text and named tools only. | Add approvals, user input, diffs, checkpoints, attachments, shell lifecycle, and structured usage. |
| Restart takeover | Slack final delivery is durable, but a replacement controller still cannot fully reattach to and project every already-running central turn after restart. Slack completion jobs use a Postgres outbox with atomic reservation, lease recovery, heartbeats, idempotency keys, and attempt fencing. | Add durable active-turn ownership and event-cursor takeover, then exercise a rolling deployment during a live turn. |
| Existing-thread provider changes | Legacy Compadre could reconstruct neutral context after a provider switch; hosted T3 currently fixes Codex vs. Claude after a thread's first turn. | Decide whether provider switching is required, then support it without losing the thread's central transcript or isolated filesystem. |
| Slack channel metadata | Proven on the isolated Comprehensive app; the official app's scopes were reconciled, but a canonical production metadata lookup has not yet been recorded. | Prove the lookup with the production app, then continue the soak across every supported public channel, private channel, and DM type. |
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
