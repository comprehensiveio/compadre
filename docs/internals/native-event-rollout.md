# Native event transport rollout constraints

The target is native provider-event delivery over durable thread streams, with
existing central conversations preserved and the custom bridge removed after
migration. Production still uses the custom bridge. The controls below are
required before enabling cutover; they are not existing operator endpoints.
The first preparation change is the central PostgreSQL
[application compatibility check](hosted-postgres-persistence.md#schema-and-import-boundary).
It introduces no schema migration or transport switch.

## Rollback boundaries

Use separate controls for separate operations:

| Control                | Required behavior                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capture off            | Disable optional native shadow recording while the current bridge remains the delivery authority. Preserve recorded data. Shadow capture cannot qualify a stream as complete after gaps or capture failures. |
| Stop cutover           | Admit no additional native threads. Threads already migrated keep their durable native binding.                                                                                                              |
| Pause native dispatch  | Reject or durably defer new provider work on native threads before execution starts. Preserve reads, pending commands, cancellation and recovery.                                                            |
| Pause native ingestion | Stop applying native events centrally; preserve durable append, incoming events and cursors so delivery can resume. Report the pause rather than showing misleading live progress.                           |

Native controls must be durable, checked at the owning operation's commit
boundary, and effective across controller replacement. Test a stale process
that passed an earlier check: it must not commit after losing authority.
Operator controls must use the authenticated operations boundary, report their
current state, and offer an explicit resume action. Stopping ingestion alone
does not stop agents or their cost; use dispatch/cancellation controls when
execution also needs to stop. Bound the queue and stop accepting work before
storage exhaustion.

Capture-only rollout is reversible by disabling capture or reverting the
application to the verified baseline, while leaving the original delivery
path authoritative. Once a thread accepts native writes, turning off migration
must not route that thread through the old projector. Recovery pauses/retries
the native path or uses an older **native-capable** application binary. A
native-to-legacy return requires a separately validated reverse migration with
event-boundary reconciliation; it is not an automatic exception handler.

There are two distinct rollback baselines: the initial binary that tolerates
compatible additive database migrations, and the later native-capable binary
that can consume migrated threads. Schema compatibility alone does not provide
protocol compatibility. Preserve the database and stream log during application
rollback. Verify both the rollback binary's pre-deploy migration command and
its startup against the upgraded database.

## Progressive activation and cleanup

Deploy storage/consumer capability with migration disabled, then producer
capability, and exercise capture on selected workers. Activate native delivery
for selected canonical threads only after durable outbox capture, central
ingestion receipts, request/answer routing, and pause/resume have been proved.
Exercise Codex and Claude, controller and central restarts, restored workers,
background completion after the parent turn, replay without duplicate text,
and the relevant browser/Slack/API entrypoints before expanding the cohort.

Keep old central message records and canonical thread IDs. Migrate worker
bindings and delivery checkpoints at an explicit per-thread boundary. Reconcile
recoverable output that never reached central storage before removing its
source. A parent turn ending does not establish that boundary if child tasks,
continuation turns, or pending interactions still exist. Central conversation
reads remain independent of worker availability.

Temporary coexistence permits independent service deployments. Each thread has
one delivery authority; no permanent legacy reader or exception-based fallback
remains after migration. Delete the snapshot projector, custom-event decoder,
legacy stream translation and redundant recovery snapshots after all retained
bindings are resolved, legacy writers are fenced, and the rollback window is
closed. Audit shared compatibility API/artifact users before removing their
dependencies. Retain Temporal lifecycle management, worker recovery and the
single Slack-delivery outbox owner.

Record the deployed baseline commits and protocol/schema versions before each
activation stage. Production cutover requires evidence from the actual
entrypoints; local integration tests do not establish that the deployed switch
or rollback path works.
