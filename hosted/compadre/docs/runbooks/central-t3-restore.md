# Central T3 state restore

This is the **pre-cutover SQLite recovery** procedure. After PostgreSQL accepts
production writes, use [PostgreSQL cutover and restore](./central-t3-postgres-cutover.md)
and never revert to the frozen SQLite snapshot. The disk is retained during this
migration's single-process phase.

Before the approved cutover, central T3 SQLite is the authoritative hosted transcript. The
controller downloads a transactionally consistent online snapshot from T3,
verifies its SHA-256 digest, and writes it to the private Comprehensive
`compadre` bucket under `backups/t3-state/v1/YYYY/MM/DD/` every six hours.

This procedure is intentionally manual. Restoring is a destructive operation
against the central writer and must have an incident owner.

## Preconditions

1. Confirm the target is the Comprehensive deployment and AWS account
   `629591269808`, never the Tolt deployment.
2. Stop Slack/API ingress and the controller before stopping central T3.
3. Confirm no central T3 process has the SQLite database open. There must be
   exactly one writer before and after the restore.
4. Download the selected object and compare its SHA-256 with both the filename
   and the object's `sha256` metadata.
5. Run `PRAGMA integrity_check` against the downloaded snapshot and require the
   single result `ok`.

## Restore

1. Preserve the current database, `-wal`, `-shm`, and attachment directory as a
   timestamped incident copy on the persistent disk.
2. Copy the verified snapshot to the configured SQLite path using a temporary
   filename on the same filesystem, then atomically rename it into place.
3. Remove only the old database's `-wal` and `-shm` sidecars. Never copy
   sidecars from a different snapshot.
4. Start central T3 and require its health endpoint, projection bootstrap, and
   `PRAGMA integrity_check` to succeed before starting the controller.
5. Programmatically read several known threads and verify message text, tool
   activity, attribution, participants, usage, and Slack bindings.
6. Start the controller, submit one API canary, then one `#slack-bot-test`
   canary. Confirm the browser reads the durable transcript without Modal.

## Pre-cutover attachment limitation

The current scheduled object is the SQLite database, not the central T3
attachment directory. Render's persistent disk remains the primary copy of
uploaded input files. Before production cutover, mirror those bytes to object
storage or include them in a separately versioned backup and rehearse restoring
them alongside SQLite.


The PostgreSQL candidate introduces a central attachment object manifest and
content-addressed S3 writes. Run its explicit attachment importer and prove
manifest completeness/hydration before relying on that ownership. No existing
production attachments have been moved by preparing the code change.
