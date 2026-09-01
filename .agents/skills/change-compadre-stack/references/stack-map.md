# Compadre stack map

Use this reference to decide where a change belongs before opening files.

## Runtime and repository map

```text
Slack / compatibility API
             |
             v
Compadre controller ingress on Render -------------------+
compadre-api, comprehensiveio/compadre                    |
Postgres users, Slack identities, bindings                |
                                                          |
Browser --------------------------------------------------v
                                                 central T3 on Render
                                                 compadre-web
                                                 comprehensiveio/t3code
                                                 SQLite event log + projections
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

| Concern | Authoritative owner | Common implementation location |
| --- | --- | --- |
| Conversation events, messages, turns, activities, tool history, approvals, central usage projection | Central T3 SQLite | T3 fork `apps/server/src/orchestration`, `apps/server/src/persistence` |
| Web rendering and interaction | T3 web client | T3 fork `apps/web`, shared contracts/runtime packages |
| Browser sessions | Central T3 SQLite, issued through controller-verified Slack OIDC | T3 fork auth plus Compadre `src/routes/slack-auth.ts` |
| Canonical users and workspace-scoped Slack identities | Compadre Postgres | `src/db/schema.ts`, user/auth services |
| Slack/API to canonical-thread binding | Compadre Postgres | hosted-thread and T3 binding services |
| Native run lifecycle, ordered delivery events, cancellation | Compadre Postgres | `src/durability`, `src/t3`, route adapters |
| Native run execution orchestration (dispatch-once, watch retry/resume, finalize convergence) | Temporal (`compadre-temporal` service, state in `compadre-temporal-db`) | `src/temporal`, `src/t3/native-t3-run-driver.ts`, `src/t3/run-service.ts` |
| Slack completion reservation/recovery | Compadre Postgres outbox | `src/services/slack-turn-delivery*` |
| Slack ingress durability/dedupe (persist before ack) | Compadre Postgres inbox | `src/services/slack-inbox*`, `src/routes/slack-events.ts` |
| Checkout, shell, provider process, worker-local transcript | One Modal worker per thread | `src/t3/modal-worker.ts`, `src/tanstack/modal-sandbox.ts` |
| Generated attachments/artifacts | Private Comprehensive object storage plus metadata | Compadre artifact services; `s3://compadre` |
| Logs, APM traces, LLM input/output/usage/cost | Datadog | controller, web, and worker telemetry |

Duplicated recovery projections are not new authorities. In particular,
Postgres worker snapshots may duplicate text for recovery, but central T3
remains the transcript rendered to users.

## Change routing

| Requested change | Start in | Usually deploys |
| --- | --- | --- |
| Chat layout, sidebar, theme, labels, model picker | T3 fork `apps/web` | `compadre-web` |
| Central auth/session, thread projection, usage UI/server | T3 fork `apps/server` and possibly contracts/web | `compadre-web` |
| Slack ingress, context, attachments, status, final delivery | Compadre controller | `compadre-api` |
| Compatibility API behavior | Compadre routes/durability plus central T3 adapter | `compadre-api`; sometimes both |
| MCP or private-service connection | Compadre MCP registry/bridge | `compadre-api`, then new Modal turns |
| Projected agent skill or prompt | Compadre skill/prompt projection | `compadre-api`, then new/restored workers |
| Baked CLI/system package | Compadre Modal image construction | `compadre-api`; verify a freshly provisioned worker |
| Provider/model UI identity | T3 fork | `compadre-web` |
| Provider execution transport/event mapping | Both repositories | coordinated web then API rollout |
| Per-thread filesystem/dev server/database | Compadre Modal worker/runtime | `compadre-api` |
| Conversation schema | T3 SQLite migration | `compadre-web` |
| Control-plane schema | Compadre Postgres/Drizzle migration | `compadre-api` pre-deploy |
| Run orchestration (workflow/activities/driver, retries, cancellation) | Compadre `src/temporal` + `src/t3` driver; keep running histories replayable (`patched()`) | `compadre-api`; verify with `npm run temporal:probe` |

## Cross-repository contracts

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
3. Add contract fixtures/tests in both repositories.
4. Deploy the tolerant consumer before a producer that emits the new shape.
5. Keep fallback behavior through at least one complete rollout and active-run
   drain.
6. Verify browser, Slack, reconnect/replay, and central persistence—not just the
   direct HTTP exchange.

The repositories auto-deploy independently. Never require simultaneous merges.

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
