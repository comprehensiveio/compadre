# Database changes

Choose the database from ownership, not from which client asks for the feature.
Compadre deliberately has two durable databases with different jobs.

## Decision table

| Data                                                                                                                                                        | Database                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Messages, turns, activities, tool history, approvals, central usage projections, T3 sessions and UI read models                                             | Central T3 SQLite                                             |
| Canonical people/Slack identities, auth handoff records, Slack/external bindings, run lifecycle and event delivery, worker leases/recovery, delivery outbox | Compadre Postgres                                             |
| Checkout files, local dev database, provider-native transcript                                                                                              | Modal worker filesystem/snapshot; never the central authority |

If a proposed table mixes conversation content with worker leases or Slack
delivery, split the model at the existing boundary instead of choosing one
database arbitrarily.

## Compadre Postgres and Drizzle

Authoritative files:

- schema: `hosted/compadre/src/db/schema.ts`
- Drizzle config: `drizzle.config.ts`
- generated migrations and snapshots: `hosted/compadre/drizzle/`
- migration execution tests: `hosted/compadre/src/db/migrations.test.ts`
- persistence/conformance tests: `hosted/compadre/src/persistence` and `hosted/compadre/src/durability`

Before reading or editing Drizzle files, load the matching Drizzle Intent
skills required by the root `AGENTS.md`.

Workflow:

1. Change `hosted/compadre/src/db/schema.ts`.
2. Generate a committed migration with `npm run db:generate`; do not hand-edit
   a Drizzle snapshot to manufacture the desired diff.
3. Inspect the SQL. Confirm nullability, defaults, constraints, indexes,
   backfill cost, locks, and compatibility with both old and new controller
   processes during a Render rollout.
4. Add a migration test and focused store/service tests.
5. Run at least:

   ```bash
   npm run db:check
   npm run test:persistence
   npx tsx --test src/db/migrations.test.ts <focused-tests>
   npm run typecheck
   ```

6. Keep migrations forward-only. Add columns/tables compatibly before removing
   an old read path. Do not use `drizzle-kit push` against production.

Render runs `npm run db:migrate` as the controller's pre-deploy command. A
pre-deploy migration failure must prevent new code from receiving traffic.
Because old and new instances can overlap during rollout, an application
rollback is safe only when the migrated schema remains compatible with the old
binary.

Live proof should include migration logs, schema/version evidence, one existing
record path, one new write/read path, and controller health. Redact row content
and credentials.

## Central T3 SQLite

Authoritative files at the monorepo root:

- migrations: `apps/server/src/persistence/Migrations/NNN_Name.ts`
- registry/order: `apps/server/src/persistence/Migrations.ts`
- projections: `apps/server/src/orchestration`
- production database: `/var/data/t3code/userdata/state.sqlite` under the
  central Render persistent disk configuration

T3 migrations are statically imported and run automatically at startup.

Workflow:

1. Select the next unused numeric migration ID. Never reuse an ID with a new
   name; Effect records the ID/name in `effect_sql_migrations`.
2. Add the migration file, import, and ordered registry entry.
3. Update command/event/projector contracts and read models together.
4. Add a focused migration test covering an old database shape and any
   backfill/idempotency behavior.
5. Test against a safe copy of realistic data:

   ```bash
   vp test run <migration-and-projection-tests>
   vp run migrate-dev-db
   ```

   `migrate-dev-db` rebuilds the worktree's `.t3` state from a consistent
   snapshot and detects migration-slot collisions. Never point a development
   server or migration command at `~/.t3/userdata` or the production disk.

6. Follow the root `AGENTS.md` focused typecheck/build guidance.

Before a risky production migration, verify the authenticated online SQLite
backup is current and that `hosted/compadre/docs/runbooks/central-t3-restore.md`
is usable. A persistent disk is not a backup.

Live proof should show:

- the new `compadre-web` commit is live;
- startup migrations completed;
- an existing authenticated thread still renders;
- the new write and projection survive a reload;
- central reads succeed without contacting Modal;
- backup and SQLite integrity signals remain healthy.

## Worker-local state

Each Modal worker also runs a T3 server with worker-local state. A T3 SQLite
migration may therefore encounter both the central persistent disk and older
worker snapshots. Ensure the worker's installed T3 fork contains the same
migration and can open restored worker state. Test both a fresh worker and a
restored filesystem image.

Do not infer that a successful central migration proves worker snapshot
compatibility.
