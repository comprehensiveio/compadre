# Compadre stack map

> Hosted central T3 uses the existing Compadre PostgreSQL database in the
> `compadre_t3` schema (cut over 2026-09-05); controller tables remain in `public`.
> SQLite remains the local/desktop/Modal backend. Keep the Render disk and
> single-process deployment: reactor ownership, signing secrets/configuration
> and workspace restore still block disk removal. See
> `docs/internals/hosted-postgres-persistence.md` and
> `hosted/compadre/docs/runbooks/central-t3-postgres-cutover.md`.

Use this reference to decide where a change belongs before opening files.

## Runtime and layout map

```text
Slack / compatibility API
             |
             v
Compadre controller ingress on Render -------------------+
compadre-api, hosted/compadre/ in this monorepo           |
Postgres users, Slack identities, bindings                |
                                                          |
Browser --------------------------------------------------v
                                                 central T3 on Render
                                                 compadre-web
                                                 monorepo root (apps/*)
                                                 PostgreSQL event log + projections
                                                          |
                                                          | native provider command
                                                          v
                                                 Compadre execution bridge
                                                 same compadre-api service
                                                 Postgres lifecycle/recovery
                                                          |
                                                          | one isolated environment
                                                          v
                                                 Modal worker for the thread
                                                 worker-local T3 server
                                                 Codex or Claude Code
                                                 checkout/shell/dev stack
```

Production endpoints:

- Web and central T3: `https://compadre.comprehensive.io`
- Controller, Slack events, auth callback, and compatibility API:
  `https://compadre-api.comprehensive.io`
- Authenticated per-thread previews:
  `https://<canonical-thread-id>.dev.compadre.comprehensive.io`

## Durable ownership

| Concern                                                                                             | Authoritative owner                                                     | Common implementation location                                                                                            |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Conversation events, messages, turns, activities, tool history, approvals, central usage projection | Central T3 PostgreSQL                                                   | root `apps/server/src/orchestration`, `apps/server/src/persistence`                                                       |
| Web rendering and interaction                                                                       | T3 web client                                                           | root `apps/web`, shared contracts/runtime packages                                                                        |
| Browser sessions                                                                                    | Central T3 PostgreSQL, issued through controller-verified Slack OIDC    | root apps/server auth plus `hosted/compadre/src/routes/slack-auth.ts`                                                     |
| Canonical users and workspace-scoped Slack identities                                               | Compadre Postgres                                                       | `hosted/compadre/src/db/schema.ts`, user/auth services                                                                    |
| Slack/API to canonical-thread binding                                                               | Compadre Postgres                                                       | hosted-thread and T3 binding services                                                                                     |
| Native run lifecycle, ordered delivery events, cancellation                                         | Compadre Postgres                                                       | `hosted/compadre/src/durability`, `hosted/compadre/src/t3`, route adapters                                                |
| Native run execution orchestration (dispatch-once, watch retry/resume, finalize convergence)        | Temporal (`compadre-temporal` service, state in `compadre-temporal-db`) | `hosted/compadre/src/temporal`, `hosted/compadre/src/t3/native-t3-run-driver.ts`, `hosted/compadre/src/t3/run-service.ts` |
| Slack completion reservation/recovery                                                               | Compadre Postgres outbox                                                | `hosted/compadre/src/services/slack-turn-delivery*`                                                                       |
| Slack ingress durability/dedupe (persist before ack)                                                | Compadre Postgres inbox                                                 | `hosted/compadre/src/services/slack-inbox*`, `hosted/compadre/src/routes/slack-events.ts`                                 |
| Checkout, shell, provider process, worker-local transcript                                          | One Modal worker per thread                                             | `hosted/compadre/src/t3/modal-worker.ts`, `hosted/compadre/src/tanstack/modal-sandbox.ts`                                 |
| Generated attachments/artifacts                                                                     | Private Comprehensive object storage plus metadata                      | Compadre artifact services; `s3://compadre`                                                                               |
| Logs, APM traces, LLM input/output/usage/cost                                                       | Datadog                                                                 | controller, web, and worker telemetry                                                                                     |

Duplicated recovery projections are not new authorities. In particular,
Postgres worker snapshots may duplicate text for recovery, but central T3
remains the transcript rendered to users.

## Change routing

| Requested change                                                      | Start in                                                                                                          | Usually deploys                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Chat layout, sidebar, theme, labels, model picker                     | root `apps/web`                                                                                                   | `compadre-web`                                       |
| Central auth/session, thread projection, usage UI/server              | root `apps/server` and possibly contracts/web                                                                     | `compadre-web`                                       |
| Slack ingress, context, attachments, status, final delivery           | `hosted/compadre/` controller                                                                                     | `compadre-api`                                       |
| Compatibility API behavior                                            | Compadre routes/durability plus central T3 adapter                                                                | `compadre-api`; sometimes both                       |
| MCP or private-service connection                                     | Compadre MCP registry/bridge                                                                                      | `compadre-api`, then new Modal turns                 |
| Projected agent skill or prompt                                       | Compadre skill/prompt projection                                                                                  | `compadre-api`, then new/restored workers            |
| Baked CLI/system package                                              | Compadre Modal image construction                                                                                 | `compadre-api`; verify a freshly provisioned worker  |
| Provider/model UI identity                                            | root `apps/*`                                                                                                     | `compadre-web`                                       |
| Provider execution transport/event mapping                            | Both layers (root and `hosted/compadre/`)                                                                         | coordinated web then API rollout                     |
| Per-thread filesystem/dev server/database                             | Compadre Modal worker/runtime                                                                                     | `compadre-api`                                       |
| Conversation schema                                                   | T3 SQLite and PostgreSQL migrations                                                                               | `compadre-web`                                       |
| Control-plane schema                                                  | Compadre Postgres/Drizzle migration                                                                               | `compadre-api` pre-deploy                            |
| Run orchestration (workflow/activities/driver, retries, cancellation) | `hosted/compadre/src/temporal` + `hosted/compadre/src/t3` driver; keep running histories replayable (`patched()`) | `compadre-api`; verify with `npm run temporal:probe` |

## Cross-layer contracts

T3 initiates a native Codex or Claude provider turn through the controller.
Compadre wraps the native stream with any controller-side Slack mirroring,
persists ordered run events through its Postgres-backed coordinator, and
exposes the resumable stream to central T3. Central T3 then persists the
canonical conversation consumed by the web UI. Slack live mirroring and
central T3 are separate consumers; do not assume Slack waits for central T3
persistence. Slack-originated final delivery remains controller/outbox-owned.

Mid-generation browser and Slack messages are steers on the same visible T3
turn. The hosted adapter detaches its older controller-stream reader (the
durable producer continues) before opening the steering stream. At terminal,
the newest user message owns Slack final delivery; superseded outbox/mirror
paths must not post a failure, duplicate the answer, or clear shared status.

For a protocol change:

1. Identify the contract on both sides and the negotiated
   `X-Compadre-T3-Protocol-Version`.
2. Make consumers tolerate both the old and new shape.
3. Add contract fixtures/tests on both sides of the seam.
4. Deploy the tolerant consumer before a producer that emits the new shape.
5. Keep fallback behavior through at least one complete rollout and active-run
   drain.
6. Verify browser, Slack, reconnect/replay, and central persistence—not just the
   direct HTTP exchange.

The services auto-deploy independently from the same repository. Never
require a single commit to be an atomic rollout across services.

## Organization boundary

Every cloud mutation must target Comprehensive explicitly.

- Render workspace: Comprehensive (`tea-ci5g47tgkuvgpf98aimg`)
- Modal application/environment: Compadre/Comprehensive configuration
- AWS account: Comprehensive account `629591269808`
- Artifact bucket: private `compadre` bucket, scoped prefixes such as
  `attachments/`

This machine also accesses Tolt infrastructure. Similar names, credentials, or
patterns are not evidence that a resource belongs to Comprehensive. Resolve
the account/workspace and target before mutating. Never inspect or change Tolt
resources as part of Compadre work.
