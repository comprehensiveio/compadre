# Central T3 PostgreSQL cutover and restore

**Prepared only; not executed. Production mutations require explicit approval.**
The implementation supports one central process. The overlap gate below is
blocked by process-local reactors. Do not remove the Render disk or declare
zero-downtime deployment solved. Architecture and exact table inventory:
[central PostgreSQL persistence](../../../../docs/internals/hosted-postgres-persistence.md).

## Approval gates and cutover

1. **Verify the existing application database.** Confirm Comprehensive workspace
   `tea-ci5g47tgkuvgpf98aimg` and AWS account `629591269808`. Reuse
   `compadre-postgres`, PostgreSQL 17 in Oregon, database
   `compadre_t3_experiment_postgres`, its existing credential, with controller tables in `public` and central
   tables in `compadre_t3`.
   No new data database, role or password is required. The staged Blueprint binds
   that database's private connection string to `COMPADRE_T3_POSTGRES_URL` on
   `compadre-web`. Do not change the controller connection or Temporal database.
   Confirm paid backup/PITR coverage and measured capacity for controller traffic
   plus at least 13 central connections and migration/backup/admin headroom.
   Resize the existing service only if measurements require it and approval is
   given. Bind the existing controller AWS credentials to web using the staged
   fromService references and verify access to `compadre/attachments/v1/central-t3/*`;
   any missing IAM permission is a separate approval gate, not a password rotation.
   Keep bucket public access blocked, encryption enabled, and versioning enabled.

2. **Apply migrations explicitly.** Use the candidate's built server artifact:

   ```sh
   node apps/server/dist/bin.mjs migrate-postgres
   ```

   It uses `COMPADRE_T3_POSTGRES_URL`; a failure blocks serving. Inspect
   `compadre_t3.compadre_t3_migrations` and all central table/index/constraint definitions.
   Record the controller's Drizzle history and representative records before and
   after; central migrations must leave them unchanged. Controller tables retain
   their existing names. Central tables retain their SQLite repository names.
   The migration tools remain independent in their respective schemas. The central
   migration CLI creates `compadre_t3` and never runs DDL in controller `public`.
   Use direct private PostgreSQL connectivity for LISTEN, not a transaction-mode
   proxy. No application-wide grants or role alterations are needed.

3. **Rehearse a consistent snapshot.** Use the existing authenticated SQLite
   online backup endpoint or SQLite backup API, never a live file copy. Require
   exactly `ok` from `PRAGMA integrity_check`, compute SHA-256, and store the
   standalone snapshot plus a manifest in the private bucket under
   `backups/t3-state/v1/migration/<timestamp>/<sha256>.sqlite`. Preserve the snapshot
   version ID, SHA-256, source/binary migration versions and row-count report as
   an immutable audit artifact (restricted deletion or approved Object Lock).
   Preserve attachment bytes and required environment secrets/configuration in
   an independently encrypted recovery artifact. Rehearse steps 5–7 in a
   disposable target before scheduling the production window.

4. **Quiesce the SQLite writer.** Schedule a bounded maintenance window. Pause
   new trigger dispatch and Slack/API/browser writes. Require zero active turns
   in both central T3 and the controller before stopping the one central writer:
   let them finish, or obtain explicit approval to cancel them and await their
   durable terminal receipts. An empty browser does not prove the platform is
   idle. Prove the stopped writer cannot accept
   another command. Take the **final** consistent snapshot after quiescence and
   repeat step 3's integrity/digest archive. The earlier rehearsal snapshot is
   not the final authority. Set a maximum 30-minute final import window; before
   PostgreSQL accepts writes, abort to the unchanged SQLite writer if it expires.
   Keep the controller's durable inbox/outbox/Temporal records, never clear them.

5. **Import and verify.** All central target tables must be empty; existing
   controller data remains in place. A failed import leaves no partial central
   data. Import from the standalone final snapshot using the candidate artifact:

   ```sh
   node apps/server/dist/import-sqlite-to-postgres.mjs /secure/state.sqlite '<verified-sha256>'
   node apps/server/dist/import-central-attachments.mjs /secure/attachments
   ```

   `COMPADRE_T3_POSTGRES_URL` is the same existing database URL for the importer,
   migrations and server. Set
   `COMPADRE_T3_ATTACHMENT_BUCKET=compadre` and
   `COMPADRE_T3_ATTACHMENT_REGION=us-west-2`. Save the table hash/count report,
   exact event range, stream-head count and all projection cursors. Compare
   representative auth, attribution, participant, trigger-origin and runtime
   records without logging private contents. Import all attachment files except
   unfinished `.part` uploads; verify every canonical attachment has a manifest
   entry and an accessible, matching object. The importer verifies all imported
   files but this transcript-to-manifest completeness audit remains an operator
   gate. Abort if any referenced byte is missing.

6. **Deploy one PostgreSQL canary.** This is a maintenance cutover, not a blue/green
   rollout. The old SQLite writer stays stopped. Configure explicit PostgreSQL
   mode and `COMPADRE_T3_REACTOR_MODE=single-process`. Preserve the attached disk,
   signing secrets, settings, environment ID and bootstrap workspace. Keep public
   ingress in maintenance until the canary is proven. Never start a second full
   central server against this target. Deploy the controller's tolerant backup
   caller before central stops offering SQLite backups; it retires its timer only
   after the authenticated PostgreSQL-specific 410 response.

7. **Verify the product.** Browser login/logout, shell and historical transcripts,
   attribution/participants, input uploads, generated artifacts, Codex and Claude
   turns, steer and cancel, Slack entry and exactly one final delivery, scheduled
   triggers, reload/reconnect, and SQL persistence after central restart. Reads of
   completed threads must not wake Modal. Programmatic checks precede a requested
   browser pass. Production Slack messages and provider turns require explicit
   authorization. Verify actual backend and deployment commit, not just static
   `/` health. Inspect central SQL event/receipt/cursor consistency and the
   controller's independent lifecycle/outbox records through their owning APIs.

8. **Overlap gate — currently BLOCKED.** Implement database-backed ownership of
   all consumers listed in the architecture document, durable pending-event
   recovery and bounded transfer/drain before attempting disk removal. Then run
   an automated continuous canary throughout an overlapping old/new Render
   rollout: authenticated shell and historical-thread reads, event cursor
   continuity, a long-running turn with steer/cancel, and durable dispatch counts.
   Require zero HTTP 5xx, no transcript outage, no lost turn and no duplicate
   launch/steer/cancel/checkpoint/Slack effect. Kill the retiring process at claim,
   send and completion boundaries, and prove safe recovery within Render's
   supported shutdown window after disk removal. Render rejects a custom
   shutdown delay while the disk is attached. This branch has no such proof. A
   separately approved single-process maintenance cutover may proceed without
   completing this gate, but must keep the disk and availability TODO.

9. **Enable normal routing.** Only after step 7 passes and either the single-process
   exception is approved or step 8 passes. Resume controller ingress and Temporal
   schedules, and verify the inbox drains without duplicate central commands.

10. **Observe a 24-hour rollback window.** Keep the operator on call, continuous
    authenticated read/write telemetry, backup freshness alerts and retained audit
    artifacts. Alert on SQL connection exhaustion, event replay lag, receipt
    failures, missing objects and controller delivery anomalies. Prove at least
    one backup and disposable restore before declaring the migration stable.

11. **Separate cleanup approval.** Only after overlap/drain proof, configuration
    and signing-key ownership, workspace/checkpoint reconstruction, attachment
    completeness and restore rehearsal may a later change remove the Render
    disk, frozen SQLite/sidecars and obsolete SQLite backup credentials/code.
    Preserve the final immutable audit snapshot through the agreed audit period.

## Render mechanics for the approved maintenance cutover

Use the same candidate commit throughout. Keep automatic deploys paused until
`main` contains the PostgreSQL-compatible binary, so an unrelated push cannot
reintroduce a SQLite-only server. The final Blueprint describes the serving
configuration; do not apply it as an unattended one-step migration.

1. Deploy the controller's backward-compatible backup caller first.
2. On web, bind the existing private database URL and existing controller AWS
   credentials, set the PostgreSQL pre-deploy migration command, and retain the
   existing `t3code-state` disk (`dsk-da73c515efls738hsgh0` at `/var/data`);
   do not create or replace it. For the first candidate deployment, temporarily use this maintenance
   start command and `/migration-health` as the health check:

   ```sh
   node -e 'require("node:http").createServer((req,res)=>{res.statusCode=req.url==="/migration-health"?200:503;res.setHeader("Retry-After","120");res.end("Compadre database migration in progress");}).listen(Number(process.env.PORT),"0.0.0.0")'
   ```

   This process never opens T3 persistence or starts reactors. Disk Recreate
   retires the SQLite writer before maintenance starts. Confirm the old instance
   is gone and no active provider turn remains before taking the final snapshot.
3. SSH into that maintenance instance, whose filesystem contains the candidate's
   bundled importers and retained disk. Use the SQLite backup API with a read-only
   source to create a standalone final snapshot under a new `/var/data` audit
   directory; never run an importer on the live `state.sqlite` path. Verify its
   integrity and SHA-256, archive it and its manifest in the versioned bucket,
   then execute step 5 above. Record exact S3 version IDs. Preserve the source,
   attachment files, signing keys and configuration unchanged.
4. Verify import reports and attachment resolution (including legacy `.bin`
   filenames), then restore the original serving start command and `/` health
   check at the same candidate commit. PostgreSQL mode remains explicit. The disk
   stays attached. Verify the canary before resuming paused controller ingress.
5. If the import fails, keep maintenance running for diagnosis. Before any
   PostgreSQL application write, reverting to the original SQLite writer is
   possible; once PostgreSQL accepts a write, use only the compatible-binary
   rollback procedure below. Never rerun an importer against populated tables.

Do not rely on shutdown to transfer an active turn. A local SIGTERM rehearsal
sent one provider cancellation, but the durable session remained running until
startup reconciliation marked it failed and cleared its active turn. Its history
remained readable and a new message could continue. That is interruption recovery,
not seamless draining. The zero-active-turn gate above is mandatory for cutover.

Maintenance returns intentional HTTP 503 responses. This is the accepted bounded
maintenance path, not the unimplemented zero-downtime overlap proof.

## Backup, retention and restore

PostgreSQL becomes authority when it first accepts a production write. Configure
managed PITR and verify the actual plan's recovery window in Render, rather than
assuming it. Read-only inspection on 2026-09-05 reported recovery AVAILABLE,
starting at 2026-08-28T15:37:43Z. Recheck immediately before cutover. Add a nightly custom-format `pg_dump` using the existing database credential,
using a PostgreSQL 17 client and an encrypted private prefix
`backups/t3-state/v1/postgres/`. Store its SHA-256, timestamp, schema version, source
commit and event range with the object. Use a consistent database-wide dump containing both controller and central
state; never dump tables independently. Shared PITR restores both together. `pg_dump --format=custom --no-owner --no-acl`
creates a restorable artifact. Use a secret environment/service file for the
connection, not a logged command argument.

Proposed policy: PITR RPO at most 15 minutes (verify the selected plan can meet
it), nightly off-service dump RPO at most 24 hours, restore RTO 60 minutes.
Retain daily dumps 35 days and monthly dumps 12 months. Keep migration audit
artifacts at least 12 months. Apply lifecycle rules only to these prefixes after
approval; never apply backup expiration to live attachment objects. Version
attachment objects and retain referenced versions for at least the database
backup horizon. The existing credential has no DeleteObject permission in its identity policy.
The bucket currently has versioning enabled and no lifecycle configuration;
retention/lifecycle changes are separate approved operations.

Monitor backup age (warn at 26 hours), failed exports, dump digest failures,
managed PITR freshness, restore-rehearsal age (warn after 35 days), SQL storage
and connection capacity, and attachment GetObject/integrity failures. The
retired SQLite timer is not a PostgreSQL backup health signal. These jobs and
alerts are provisioning gates, not resources installed by this local change.

Every month restore a selected dump into a disposable isolated PostgreSQL 17
database with outbound controller/provider/Slack writes disabled. Verify the
digest, run `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`
into the empty target, then inspect both migration histories, all table counts, event
range, stream heads, cursors, sessions, attribution and runtime records. Restore
the corresponding S3 object versions to an isolated prefix or supply read-only
access to the immutable source prefix. Start the candidate in a disposable T3
home with recovered signing/configuration secrets, and require every object to
hydrate with the stored digest. Prove authenticated historical reads and an
isolated fake-provider turn without contacting production. Record the measured
RPO/RTO and remove only rehearsal resources after approval.

## Rollback

Before any PostgreSQL production write, aborting to the quiesced original SQLite
writer is safe if no state changed elsewhere that requires reconciliation.
After the first PostgreSQL write, the SQLite snapshot is frozen history, **not**
a rollback database. Roll back only to a PostgreSQL-compatible binary against
the same central database and object store, with the same secrets and identity.
The pre-migration `main` binary is not compatible. Retain a known-good candidate
artifact before cutover. If none exists, keep maintenance mode and fix forward
or restore PostgreSQL to an explicitly approved recovery point with a declared
loss window and controller reconciliation. A shared database restore also rolls
back controller records; reconcile Temporal, Slack delivery and external effects
against that same recovery point. Never silently discard PostgreSQL
writes by switching the persistence mode back to SQLite.
