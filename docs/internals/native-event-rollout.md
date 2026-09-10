# Native event delivery

Production conversations still use the snapshot/custom-event bridge until a
thread is explicitly adopted. The native delivery endpoint and controller
reader are preparation for that cutover; their presence does not activate it.

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

Keep the rollout controls small: an adoption cohort and a pause for native
execution/delivery. Removing a thread from the adoption cohort must not send an
already adopted thread through the legacy projector. A pause must preserve
history, bindings, source events, and cursors. Resuming retries native delivery.
`COMPADRE_NATIVE_EVENT_THREADS` is a comma-separated cohort (`*` selects all
threads). `COMPADRE_NATIVE_EVENTS_PAUSED=true` pauses new native runs and delivery
without changing their ownership. Bound threads require the native-capable
transport even after removal from the cohort. The run request persists its
transport mode, so SSE reconnects cannot change modes during a rollout.

A per-thread Temporal workflow follows the worker journal independently of run
completion. A stopped controller retries from its acknowledged cursor; a newer
worker epoch ends the old consumer. Confirmed worker loss sends a fenced native
session closure to central T3. Transient connection failures retry.

Question responses, approvals, interrupts and session stops route using the
persisted central binding, without an in-memory Compadre adapter session.
Files are uploaded to the worker and become native assistant-completion commands;
the consumer copies attachment objects to central storage before acknowledging
their events. Saved workspace reviews replace worker-local checkpoint references
with durable review references through native checkpoint commands. Local refs
remain marked missing centrally until that publication completes.

For adopted runs, the controller records lifecycle receipts rather than copied
conversation chunks. The web transport consumes those receipts while the native
journal independently supplies conversation and status. The temporary legacy
projector/decoder remains only for unadopted runs during independent deployment.

Before adopting a thread, reconcile its retained history and outstanding work,
record its source boundary, and claim native ownership before dispatching new
provider work. A parent response ending does not mean background agents or their
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
Post-deploy API checks have also exercised authenticated ingestion, duplicate
batch replay, late output, and unchanged existing central history. These checks
do not establish live provider, Modal restore, Slack, or UI parity.

Before expansion, prove Codex and Claude, background continuations, interaction
responses, controller/central restarts, restored workers and artifact delivery
on the deployed entrypoints. Then remove the snapshot projector, custom-event
decoder, transcript reconstruction and redundant recovery snapshots after
retained bindings and any remaining legacy runs are migrated. Preserve Temporal
run orchestration, worker filesystem recovery and the single Slack outbox owner.
Do not leave an exception-based legacy fallback after migration.
