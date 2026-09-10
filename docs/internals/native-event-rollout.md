# Native event delivery

Hosted conversations use native delivery. Existing threads adopt their worker journal
before their next turn while preserving their central history. There is one
conversation path; the custom worker snapshot projector and central event decoder
have been removed.

## Durable owners

A worker T3 server already persists its native orchestration events in SQLite.
That journal is the source outbox. The controller reads it using the Durable
Streams catch-up/long-poll protocol and forwards bounded batches to central T3.
There is no second copy of the conversation payload in controller Postgres.

Central T3 imports assistant messages, sessions, activities, plans and checkpoint
summaries through its ordinary command engine. It preserves native payloads and
maps environment-local identifiers. Event append, projection, delivery ownership
validation, and the command receipt commit in one transaction. Replayed commands
reuse their receipts; conflicting event identities fail rather than duplicating
text. Existing central messages and canonical thread IDs remain unchanged.

`native_thread_streams` stores one central delivery binding per thread: source
thread, worker epoch, last applied source sequence, and checkpoint numbering
offset. A newer worker claim fences the previous generation under the same
transaction locks as event ingestion. The controller stores its acknowledged
read cursor in metadata namespace `compadre.t3.native-delivery.v1`, separately
from the fixed adoption boundary. It advances that cursor only after central
T3 acknowledges the batch. A lost acknowledgement therefore causes safe replay.

The authenticated worker GET/HEAD endpoint is `/api/compadre/native-events`.
Offsets are opaque to consumers. GET supports catch-up and `live=long-poll`;
HEAD discovers the current boundary. It is a read-only Durable Streams surface,
not a general stream creation/deletion service or a full protocol-conformance
claim. Central PUT claims a binding; central POST applies a versioned batch.
Those write operations require the controller credential. Clients continue
reading their existing central T3 projections and never wake a worker to open
history.

## Activation and recovery

`COMPADRE_NATIVE_EVENTS_PAUSED=true` pauses new runs and native delivery without
changing history, bindings, source events, or cursors. Resuming retries native
delivery. All hosted run transports require the native delivery capability;
there is no cohort switch or legacy fallback.

A per-thread Temporal workflow follows the worker journal independently of run
completion. A stopped controller retries from its acknowledged cursor; a newer
worker epoch ends the old consumer. Codex subscription cleanup waits for a native
provider completion with no live background work or running continuation; parent
EOF alone no longer stops that provider. Confirmed worker loss sends a fenced native
session closure to central T3. Transient connection failures retry.

Question responses, approvals, interrupts and session stops route using the
persisted central binding, without an in-memory Compadre adapter session.
The per-thread consumer publishes files and reviews from native checkpoint
completion, including checkpoints after the parent run ends. Publication happens
before acknowledging that source page, using stable per-turn IDs on retries.
Files are uploaded to the worker and become native assistant-completion commands;
the consumer copies attachment objects to central storage before acknowledging
their events. Saved workspace reviews replace worker-local checkpoint references
with durable review references through native checkpoint commands. Local refs
remain marked missing centrally until that publication completes.

For hosted runs, the controller records lifecycle receipts rather than copied
conversation chunks. Lifecycle observation long polls the journal and reads full
snapshots only initially and when turn state changes; it does not save redundant
recovery snapshots. The consumer reuses its worker connection across pages. The web transport consumes those receipts while the native
journal independently supplies conversation and status. The lifecycle transport never reconstructs provider text, tools, usage, or reviews.
Controller transcript caches and the obsolete in-process run driver are removed.
Public compatibility API formatting reads central T3 and remains an external API
boundary; it does not feed conversation events back into central storage.

An old live worker is upgraded under its dispatch lock only when its native
shell reports no active turn, background work, or pending interaction. The
controller stops the idle provider, checkpoints the filesystem, restores with
the pinned package, and validates the journal before replacing its binding.
Failed validation leaves the old binding intact. Canonical history and native
thread IDs are retained. Already expired workers use ordinary snapshot restore.
Adoption records the source boundary and claims ownership before new provider
work. Explicit runtime and interaction modes are persisted with native mode
commands before dispatch; a turn-command field alone does not change them. A parent response ending does not mean background agents or their
continuations have ended. Delivery must follow the worker journal independently
of individual provider turns. Questions and approvals must route answers back
to the worker that owns their native request IDs.

Application rollback preserves the database. The compatibility prerequisite
allows explicitly declared additive PostgreSQL schemas, including migration 2's
binding table. It does not make an old transport understand adopted threads.
Use pause and a corrected native-capable binary if a cutover fails; a general
reverse-migration system is deliberately out of scope.

## Verification and cleanup

Local tests cover real worker/central T3 projections, SQLite and PostgreSQL,
lost acknowledgements, conflicting replay, source-thread isolation, generation
fencing, bounded pages, authenticated HTTP delivery and native question payloads.
Production API canaries exercise real Codex and Claude tool output, final messages,
choice-response round trips, background-agent activity, and a Claude continuation
after parent completion. The existing agent-panel model recognizes both providers'
native child activities. Signed attachment downloads and immutable reviews remain
readable after the canary worker is destroyed. A retained-history canary preserves
old messages exactly and retains provider context on its first native turn. Worker
restore retains the native thread ID, central history, and checkpointed workspace.

Use the deployment runbook to verify controller takeover, worker restore and
final entrypoint behavior for subsequent changes. Visual browser and Slack delivery
checks require separate authorization; API evidence does not establish those
surfaces. Native protocol support preserves what each provider emits; it does not
invent unsupported provider capabilities or guarantee a Codex parent continuation.

During independent service rollout, activate all-thread native delivery on the
previous tolerant controller before deploying the decoder removal. Existing
central records are retained in place, not copied through a legacy read path.
Old controller metadata caches can expire under ordinary retention; no destructive
historical data purge is required for cutover.
