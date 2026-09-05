# Compadre central PostgreSQL persistence

Status: deployed on 2026-09-05 for a **single central process** after a verified
final SQLite import and attachment archive. This change does **not** complete
the zero-downtime deployment TODO. Keep the Render disk and stop-before-start
behavior until reactor ownership and the remaining disk files are resolved.

## Ownership and configuration

Central T3 owns the canonical event log, projections, cursors, command receipts,
browser sessions, pairing links, provider resume state and attachment metadata.
The hosted backend selects PostgreSQL with `COMPADRE_T3_PERSISTENCE=postgres` and
`COMPADRE_T3_POSTGRES_URL`. No URL, an unavailable database, an invalid mode, or an
unapplied migration prevents startup. An explicit SQLite setting remains
available for local/desktop/development and Modal worker-local environments.
These environments do not inherit central PostgreSQL credentials.

The controller and central T3 share the existing **`compadre-postgres` database,
credential, with controller tables in `public` and central tables in
`compadre_t3`**. No additional data database, role, password or
migration credential is needed. The Blueprint references its private
connection string as `COMPADRE_T3_POSTGRES_URL` on `compadre-web`; this is another
binding of the existing credential, not a secret rotation.

Read-only Render inspection on 2026-09-05 found:

- Comprehensive workspace `tea-ci5g47tgkuvgpf98aimg`;
- `compadre-web`: one starter instance, 1 GB `/var/data` disk;
- `compadre-postgres`: PostgreSQL 17, database `compadre_t3_experiment_postgres`,
  basic_256mb, 1 GB storage, no HA;
- an independent PostgreSQL 16 Temporal database and a separate legacy database.

Temporal stays separate and unchanged. The legacy database is outside this
migration. Monitor the shared database's connection, memory and
storage headroom, including controller traffic. A pre-cutover read-only SQL probe found 12 connections out of
a 103-connection limit, 41 MB controller data and CREATE-schema permission on
the existing role. This proves connection headroom, not peak compute capacity;
resize the existing service if
needed, with approval. A small current plan does not require another database.

Controller tables already use `compadre_` names. Central tables retain their
existing names for repository compatibility and upstream merge maintenance.
The controller stays in `public`; the central pools pin `search_path=compadre_t3`
on every connection, including LISTEN connections. Central lookup never falls
back to controller tables. The explicit migration CLI creates this schema. Migration histories remain independent because the controller uses
Drizzle and central T3 uses Effect SQL. This is code ownership, not database-role
isolation. Existing HTTP contracts remain unchanged and this migration adds no
cross-service SQL joins.

Applications do not run migrations. `node apps/server/dist/bin.mjs migrate-postgres`
uses the same URL, takes a migration advisory lock and applies
`compadre_t3.compadre_t3_migrations`. It permits controller tables and refuses to
adopt pre-existing central tables without central migration history. The importer
requires empty central target tables, not an empty shared database. Do not run
it from pre-deploy: [Render pre-deploy runs on separate compute without the
disk](https://render.com/docs/deploys).

## Schema and import boundary

`CompadrePostgresSchema.ts` represents Compadre SQLite migrations 001–044. The
PostgreSQL table set does not include Tolty preferences or its `unsettled_at`.
It does include Compadre `attribution_json`, `started_by_user_id`,
`participants_json` and `external_thread_json`.

The importer copies these **15** tables, with every column required:

| Canonical / operational        | Projections                      |
| ------------------------------ | -------------------------------- |
| orchestration_events           | projection_projects              |
| orchestration_command_receipts | projection_threads               |
| checkpoint_diff_blobs          | projection_thread_messages       |
| provider_session_runtime       | projection_thread_activities     |
| auth_pairing_links             | projection_thread_sessions       |
| auth_sessions                  | projection_turns                 |
|                                | projection_pending_approvals     |
|                                | projection_thread_proposed_plans |
|                                | projection_state                 |

SQLite `effect_sql_migrations` is checked exactly against the 44-entry manifest,
not installed as PostgreSQL migration history. `sqlite_sequence` high-water
values reset PostgreSQL identities. `orchestration_commit_order` and
`compadre_t3_attachment_objects` are central PostgreSQL infrastructure, not
controller tables and not SQLite import sources.

JSON and timestamps stay TEXT to retain their exact values and formatting.
SQLite integers become PostgreSQL BIGINT, decoded with a checked JavaScript
safe-integer parser. Out-of-contract integers fail rather than lose precision.
Unique event IDs and `(aggregate_kind, stream_id, stream_version)` are enforced.
`json_extract(TEXT, TEXT)` supports the dotted scalar paths used by repositories;
it is not a general SQLite JSON dialect emulator.

The importer opens a standalone snapshot read-only, starts a read transaction,
requires exactly `ok` from `integrity_check`, validates its supplied SHA-256 and
rejects a nonempty WAL, unknown/missing tables, or different migration/column
inventories. All target tables are locked before testing emptiness. It imports
and compares a canonical per-table hash of **every cell**, plus row counts,
event min/max/count, stream heads and projection cursors, in one transaction.
Identity `ALTER SEQUENCE RESTART` is transactional; `setval` is deliberately not
used. There are no dual writes. Attachment import is a separate, repeatable
object operation after the database import.

## Command and publication semantics

All command transactions acquire the singleton commit gate **before** deciding,
then lock the command ID, aggregate and workspace keys in stable order. Project
delete additionally locks its affected threads. This deliberately serializes
command decisions across pools: project/workspace invariants and projection
cursors are global. It leaves read queries concurrent. Optimize only after
measuring contention and proving an alternative invariant boundary.

After locking, the engine reads the committed SQL projection. Accepted events,
all projections/cursors and the receipt commit together. Invariant rejection
receipts commit under the same lock; a late failure cannot overwrite acceptance.
Command-ID conflict and replay behavior remains the existing aggregate-based
contract (not a new full-payload fingerprint).

Each process publishes by catching up from its durable sequence cursor in
256-event batches under one semaphore. PostgreSQL LISTEN/NOTIFY only wakes that
reader; a one-second durable replay fallback recovers missed notifications.
The global commit gate prevents a later sequence committing ahead of an earlier
one. Reads use up to eight connections, transactions use four reserved command
connections, plus a listener. Snapshot transactions use the read pool with
REPEATABLE READ and share the command transaction connection when nested. Budget
at least 13 connections per process plus migration/backup/admin headroom.

## Reactor ownership: unresolved, single process required

`COMPADRE_T3_REACTOR_MODE=single-process` is required by PostgreSQL server
composition. It is an explicit restriction, **not** a distributed lock. The
retained Render disk enforces Recreate; do not launch another full server against
this database or remove the disk. Independent engine pools in tests prove SQL
ordering only.

This means one active `compadre-web` server, not one user, thread or provider
run at a time. `compadre-api` remains independently deployed, and Modal workers
can execute multiple threads concurrently. Normal web deployments stop the old
server before starting its replacement, causing a temporary interruption.
Shutdown can cancel an active turn; startup reconciliation preserves its history
but does not seamlessly resume it. This is an accepted, deferred rollout
limitation, not a release gate. Routine merges and deployments do not wait for
active turns, Temporal workflows or schedules to finish. Observe deployment
frequency, interruption duration and affected turns before prioritizing the fix.
PostgreSQL command idempotency does not prevent two reactors from sending the
same external provider instruction.

The side-effect inventory includes:

| Consumer                 | External or process-local responsibility                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| ProviderCommandReactor   | Launch, steer, interrupt, approve, user input, session lifecycle, title generation/workflow scripts                     |
| ProviderRuntimeIngestion | Consume adapter runtime streams, dispatch durable output, maintain per-session normalization state                      |
| CheckpointReactor        | Git/checkpoint effects, restore and checkpoint completion receipts                                                      |
| ThreadDeletionReactor    | Stop provider/terminal/preview sessions and delete thread filesystem resources                                          |
| ProviderSessionReaper    | Timer-driven provider session stop; not just an event subscriber                                                        |
| AgentAwarenessRelay      | Outbound relay publication and process-local in-flight state                                                            |
| CompadreAdapter          | Remote launch/steer/cancel and stream ownership; artifact download before event publication                             |
| WebSocket handlers       | Read/catch-up subscription; command ingress; direct terminal/preview/source-control operations remain environment-local |

A future leader must own all these effectful paths and transfer in-flight provider
stream state, durable effect cursors and pending claims. Merely gating
`OrchestrationReactor.start` is insufficient: dependencies can start timers and
adapters earlier, and a lease alone cannot fence an already-sent external call.
A command can commit immediately before a crash without its hot-stream reactor
seeing it. Recovering that window needs durable claims/reconciliation. No
exactly-once external-effect, overlap, or 300-second drain proof is claimed here.

### Proposed fix (deferred)

Reuse the controller's durable run IDs, Temporal workflow deduplication, driver
epoch fencing and output replay. Keep this change in Compadre-owned persistence
and adapter modules with narrow server lifecycle hooks; local/desktop provider
lifecycles should remain independent.

1. Persist each provider action's identity and payload before dispatch. Reuse the
   same identity after retries or restart, reject conflicting payloads, and verify
   deduplication through controller and worker dispatch, including steering and
   cancellation. A persisted action must remain recoverable if no reactor sees
   its live notification.
2. Separate server shutdown from explicit user cancellation. Detach the web
   adapter without cancelling remote execution; restore active run associations
   and replay positions when the replacement reconnects. Reconcile output without
   duplicate messages or prematurely marking the turn failed.
3. Initially allow both web instances to serve requests but elect one durable
   background owner. Transfer ownership with protection against stale owners and
   recover pending actions. Cover every effectful path in the inventory above;
   a leader lock alone does not resolve ambiguous external requests.
4. Move the remaining signing/configuration identity and required workspace/Git
   state to durable ownership with verified restoration. Only then remove the
   disk and enable overlapping Render deployments.
5. Prove active-run deployment, crash-before/after-dispatch recovery, steering,
   explicit cancellation, event replay and WebSocket reconnect using independent
   processes. A continuous rollout canary must show no failed HTTP reads, lost
   turns or duplicate effects. Keep old/new binaries and migrations compatible.

The intended handoff permits a short delay in dispatching new commands while
existing Modal runs continue and historical reads remain available. This work
has not been implemented or validated by the PostgreSQL migration. Until it is,
retain one central server and the disk; do not use routine deploys as overlap
experiments.

## Durable bytes and remaining disk files

Read-only production inspection found approximately 204 MB under `/var/data`,
including 7.8 MB attachments, 118 MB logs, 16 KB secrets and a 7.4 MB bootstrap Git
directory. No production content or secret values were copied into this branch.

Hosted attachment writes now pass through `CompadreAttachmentStore`: upload
completion, inline image/file normalization, pending-to-thread claim, and
Compadre generated artifacts. Bytes go to private
`s3://compadre/attachments/v1/central-t3/<sha256>` with encryption and checksum,
are read back and verified, then their path/key/size/digest metadata commits in
central PostgreSQL. No event/upload success may precede that step. A failed
metadata write can leave an unreferenced immutable object, never a dangling
acknowledged object reference. Changing bytes at an existing path is rejected.

On startup, PostgreSQL metadata restores attachment files to the local cache,
verifying each object's size and digest before serving. Existing synchronous
provider/file interfaces continue to work. This initial implementation hydrates
the complete manifest (four concurrent downloads); startup cost grows with
retained bytes. Cache deletion from projection transactions is disabled in
PostgreSQL mode. Object deletion/retention must preserve historical references
and backup windows; no automated garbage collection is enabled. Pending upload
metadata currently also remains until an explicit retention implementation.

| Disk category                                         | Disposition before any later removal                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite, WAL/SHM                                       | Final immutable snapshot + digest; PostgreSQL takes ownership after cutover                                                                                 |
| Attachments                                           | Explicit initial object import; PostgreSQL metadata + S3 bytes, tested disposable hydration                                                                 |
| `secrets/`                                            | **Still required on disk**: browser/asset/upload signing keys and other environment secrets; export to managed secret ownership and rehearse before removal |
| settings/keybindings, environment-id, anonymous-id    | **Still retained**: preserve exact environment configuration/identity; decide and implement managed configuration                                           |
| `/var/data/workspace/.git`, bootstrap/checkpoint refs | **Still retained**: audit checkpoint reachability and recreate/hydrate required refs before treating as disposable                                          |
| logs/provider traces/terminal logs                    | Local diagnostics; verify Datadog retention/export before discarding                                                                                        |
| caches, usage-model-rates.json, runtime advertisement | Rebuildable after verifying configuration and stable environment identity                                                                                   |
| temporary SQLite backup sidecars                      | Obsolete diagnostic leftovers; remove only in approved cleanup, not during import                                                                           |

The disk is not yet safely removable, even though newly acknowledged attachment
bytes have another durable owner.

## Merge maintenance and verification

Future `git merge upstream/main` remains a normal merge. Preserve the narrow
persistence hooks in server/project CLI, command transaction/read model changes,
projection cursor batching, read transaction routing and byte-publication hooks.
No controller auth, trigger, telemetry or provider implementation was replaced.

Every new SQLite migration requires a corresponding PostgreSQL migration and
an update to `SQLITE_SCHEMA_VERSION`. `CompadreSqliteImport.test.ts` checks the
registry tip and compares actual migrated table/column inventories and all data
on import. Run shared repository contracts twice using the ordinary SQLite
mode and `COMPADRE_T3_REPOSITORY_TEST_URL`. PostgreSQL fixtures reject non-loopback
hosts and database names without `_test` before destructive cleanup. The
PostgreSQL integration test also applies the actual controller migrations in
public, then runs central migrations in compadre_t3 and verifies a controller
record survives and is absent from central unqualified table lookup. The
populated importer test preserves existing controller data in public.

See [central cutover and restore](../../hosted/compadre/docs/runbooks/central-t3-postgres-cutover.md)
for gates, backup policy, rollback and deliberately unproven surfaces.
