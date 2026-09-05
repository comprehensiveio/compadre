# Production cutover checklist

> **Historical record — predates the monorepo migration (2026-09-01).**
> References to the separate `comprehensiveio/t3code` fork repository describe
> the pre-monorepo layout; both halves now live in `comprehensiveio/compadre`
> (controller under `hosted/compadre/`, T3 stack at the root).

This is the running checklist for operating Compadre on the hosted T3
architecture. Keep it current as production reveals new requirements. A
checked item means the behavior was demonstrated against the deployed
Comprehensive services; dated notes distinguish pre-cutover proofs from the
official Slack application cutover.

## Proven in the isolated deployment

- [x] Slack, API, and browser entrypoints resolve to the same central T3 thread.
- [x] A browser can authenticate with the allowed Slack workspace without a
  pairing token.
- [x] Slack OpenID Connect validates state, nonce, token signature, issuer,
  audience, and workspace before creating a T3 session.
- [x] The login handoff is short-lived, single-use, and exchanged
  server-to-server.
- [x] Login returns to the exact requested project/thread path and renders the
  durable central transcript without contacting Modal.
- [x] Slack messages retain canonical user attribution and origin in the T3 UI.
- [x] Each T3 thread is bound to an isolated Modal sandbox and native Codex or
  Claude Code harness.
- [x] Agent access to T3's in-app preview browser defaults off at the server
  boundary, so the `t3-code` MCP server, its credential, prompt text, and all
  `preview_*` tools are absent from provider sessions. A fresh deployed Modal
  turn verified `T3_BROWSER_HIDDEN` on 2026-08-27.
- [x] Completed provider events can be replayed from the central event log.
- [x] Datadog receives one Agent/LLM Observability application while controller
  and worker remain distinct APM services.
- [x] Hosted provider usage is persisted centrally with model, provider, token
  totals, initiating user, and message origin; the T3 Usage page can aggregate
  it by user without reading Modal transcripts.
- [x] Datadog LLM Observability receives prompt, response, model, token totals,
  initiating user, origin, and model-priced cost for a live Slack turn.
- [x] The isolated Slack app authenticates as `Secret dre experiment`, shows
  tool-specific progress, withholds intermediate assistant narration, posts
  exactly the final T3 assistant message, and follows it with the canonical
  open session in Compadre web link from the same app identity. Live proof on
  2026-08-27 used a shell-tool turn and returned only
  `FINAL_ONLY_SLACK_VERIFIED` plus the link.
- [x] The legacy `/prompt`, `/webhook/:source`, `/ag-ui`, and `/workflow-runs`
  contracts dispatch through central T3 and complete with durable status and
  replay on the isolated deployment.
- [x] Repeated API run IDs and webhook idempotency keys do not launch duplicate
  native T3 turns; live cancellation interrupts the active turn and records an
  aborted durable run.

## Release and infrastructure

- [x] Decide the final production service names and hostnames for central T3,
  the controller, Postgres, and the persistent T3 disk.
- [x] Create production resources independently of the existing Compadre
  service so traffic can be switched gradually and rolled back.
- [x] Deploy `compadre-api` automatically from Compadre's `main` branch. The
  PR #126 production deploy was observed from commit discovery through live
  health on 2026-08-30. `compadre-web` is configured for the T3 fork's `main`;
  multiple `new_commit` deployments, including `2e5d6c4bb` on 2026-08-30,
  reached live health successfully.
- [ ] Pin the Compadre and T3 fork revisions. Publish a versioned T3 fork
  artifact and verify its SHA-256 before worker startup.
- [ ] Preserve a documented upstream T3 remote and rehearse one upstream merge
  into the fork before cutover.
- [ ] Move repository checkout/bootstrap work out of the controller's HTTP
  startup critical path. The isolated deployment took more than five minutes
  to clone the repository and reached Render's port-scan timeout before it
  became ready.
- [ ] Add separate liveness, readiness, and dependency health checks. Readiness
  must cover Postgres and required central-T3 connectivity without requiring a
  repository clone or Modal worker.
- [ ] Add graceful deploy draining: stop accepting new turns, allow or detach
  active turns, and verify that no Modal run is orphaned. The isolated T3
  deployment currently cancels active provider turns during shutdown; this has
  been reproduced and must be fixed before cutover.
- [ ] Eliminate or explicitly accommodate central-T3 deployment downtime. The
  persistent-disk Render rollout returned 502s for roughly three and a half
  minutes in an earlier rollout, and a 2026-08-31 UI deployment produced about
  two and a half minutes of 502s. The single persistent SQLite disk prevents
  old and new instances from overlapping. Move T3's authoritative persistence
  to Postgres or another transactionally equivalent non-exclusive store, then
  prove a gracefully drained rollout has no HTTP 5xx, transcript outage, lost
  active turn, or duplicate turn. Serving only the static shell separately does
  not satisfy this item because conversations would remain unavailable.
- [ ] Keep one central T3 writer and one controller instance until distributed
  ownership, leases, fencing, and command delivery are implemented.
- [ ] Define capacity limits and alerts for the Render services, Postgres,
  persistent disk, and concurrent Modal sandboxes.
- [ ] Keep the public hosted-stack synthetic monitor green. The scheduled
  `Monitor hosted Compadre` GitHub workflow probes the custom web domain, the
  direct Render web origin, the T3 environment and file-upload contract, and
  controller health on a best-effort five-minute GitHub Actions schedule. It
  is intentionally alert-only: a failed probe must not automatically redeploy
  or replace production. GitHub may delay or drop scheduled jobs, so this is
  not a hard five-minute detection guarantee.
- [ ] Set and enforce a Slack-to-first-progress and Slack-to-first-token latency
  budget. A cold isolated run currently spends meaningful time cloning the
  repository and connecting to and discovering every configured MCP before a
  trivial no-tool answer can complete.
- [ ] Instrument and reduce post-clone T3 bootstrap latency. Live sequential
  compatibility probes ranged from roughly one minute to more than three
  minutes, and concurrent fresh threads amplified the slow tail.

## Production secrets and configuration

Create fresh production credentials. Do not promote or reuse credentials from
the isolated deployment.

- [x] Use Render environment groups as the current production source of truth:
  one shared group plus service-specific API and web groups in the
  Comprehensive workspace. Keep credential values out of repository manifests
  and document ownership and rotation in `docs/production-secrets.md`.
- [ ] Revisit Doppler when centralized rotation across Render, Modal, and local
  administration is worth the added dependency. Until then, avoid creating a
  second authoritative copy of Render-managed production credentials.

Controller secrets and configuration:

- [ ] `DATABASE_URL`
- [ ] `COMPADRE_T3_CENTRAL_URL`
- [ ] `COMPADRE_T3_CENTRAL_TOKEN`
- [ ] `COMPADRE_BACKUP_TOKEN` matching the hosted T3 service
- [ ] `COMPADRE_AUTH_EXCHANGE_SECRET`
- [ ] `COMPADRE_PREVIEW_HOST_SUFFIX=dev.compadre.comprehensive.io`
- [ ] `COMPADRE_PREVIEW_GATEWAY_SECRET` matching the hosted T3 service
- [x] `COMPADRE_SLACK_WORKSPACE_ID`
- [x] `SLACK_CLIENT_ID`
- [x] `SLACK_CLIENT_SECRET`
- [x] `SLACK_SIGNING_SECRET`
- [x] `SLACK_BOT_TOKEN`
- [x] `SLACK_OIDC_REDIRECT_URI` is intentionally unset in production; the
  controller derives the callback from the public API request origin as
  `https://compadre-api.comprehensive.io/auth/slack/callback`. The same exact
  URL is allowlisted in the Slack app manifest and was verified by live login.
- [ ] Modal credentials and environment name
- [ ] GitHub App/token credentials and allowed repository configuration
- [ ] Codex/OpenAI and Claude/Anthropic harness credentials
- [ ] MCP credentials, custom-tool credentials, and installed CLI credentials
- [ ] Datadog API/application keys and OTLP endpoints
- [ ] Relay/API authentication keys used by existing integrations
- [ ] `COMPADRE_T3_PACKAGE_URL` and `COMPADRE_T3_PACKAGE_SHA256`

Central T3 secrets and configuration:

- [ ] `COMPADRE_NATIVE_T3_URL`
- [ ] `COMPADRE_CONTROLLER_URL`
- [ ] `COMPADRE_AUTH_EXCHANGE_SECRET` matching the controller
- [ ] `COMPADRE_PREVIEW_HOST_SUFFIX=dev.compadre.comprehensive.io`
- [ ] `COMPADRE_PREVIEW_GATEWAY_SECRET` matching the controller
- [ ] `COMPADRE_AUTH_COOKIE_DOMAIN=.compadre.comprehensive.io`
- [ ] `COMPADRE_BACKUP_TOKEN` matching the controller
- [ ] `VITE_COMPADRE_AUTH_ENABLED=true`
- [ ] Persistent SQLite path and disk mount
- [ ] `T3CODE_INSTALL_GH_CLI=true`
- [ ] `GH_TOKEN` scoped for the repository operations exposed by the T3 UI
- [ ] Ensure the retired `COMPADRE_PROVIDER_URL` is unset
- [ ] Wildcard DNS and Render custom domain for
  `*.dev.compadre.comprehensive.io` resolve only to the hosted T3 gateway

For every secret, record its owner, scope, storage location, rotation procedure,
and last-rotated timestamp. Verify that no credential reaches the browser,
central transcript, Modal logs, Datadog content, or source control.

## Slack application

Canonical endpoints:

- Web UI: `https://compadre.comprehensive.io`
- Slack Events/API: `https://compadre-api.comprehensive.io/slack/events`
- Slack OIDC callback: `https://compadre-api.comprehensive.io/auth/slack/callback`

- [x] Update the current Compadre Slack app in place so existing channel
  membership and user expectations are preserved. The official app now owns
  production Slack ingress; keep the old Render relay only as a rollback target
  until the post-cutover soak is complete.
- [x] Set the production event request URL to `/slack/events` and pass Slack's
  verification challenge.
- [x] Add the exact production `/auth/slack/callback` redirect URL and complete
  a real OpenID Connect login through it.
- [x] Configure and authorize Sign in with Slack scopes: `openid`, `profile`,
  and `email`.
- [x] Reconcile bot scopes and events with the checked-in manifest, including
  mentions, DMs, channel history, message writing, reactions, user lookup, and
  file access. The official app subscribes to `app_mention` and `message.im`.
- [x] Grant and verify `files:read` for image inputs and `files:write` for
  generated artifact delivery on the official app installation.
- [x] Prove those file scopes plus conversation metadata scopes on the isolated
  Comprehensive app and reinstall it before production cutover.
- [x] Reauthorize the official app for OpenID Connect and confirm the bot is
  active in `#slack-bot-test`; expand the channel-membership check as Compadre
  is used elsewhere.
- [x] Verify signing-secret validation, replay-window enforcement, event
  idempotency, Slack retry handling, and installation-specific bot identity.
  The clean 2026-08-30 redeploy authenticated as workspace `T01N1PDFS5V` and
  official bot user `U073509NYP7` using only the canonical Render env group.
- [x] Verify that a Slack thread link uses the canonical central T3 project and
  thread IDs, returns HTTP 200, and renders a completed central snapshot.
- [x] Verify Slack progress/status updates for native tools and MCP tools and
  exact final success delivery. Failure, cancellation, and resumed-run status
  remain part of the ongoing soak matrix.
- [ ] Forward Slack file attachments into native T3 turns and verify that both
  Codex and Claude can read them from their isolated workers.
- [x] Give Slack answer delivery a single architectural owner. Verify that an
  agent cannot produce a second final answer by calling a same-thread Slack
  tool after automatic final delivery. The controller now owns Slack-originated
  final delivery through a durable Postgres outbox with atomic reservation,
  lease recovery, attempt fencing, and stable Slack idempotency keys. A live
  2026-08-30 canary produced exactly one answer and one web link. A direct live
  bridge probe also proved that a destination-scoped worker credential rejects
  `slack_reply_to_thread` for its own thread and cannot be replayed without the
  destination or against another thread.
- [x] Correct the isolated app credential mismatch and verify a fresh deployed
  instance posts progress, final output, and the open session in Compadre web
  link as `Secret dre experiment` rather than the legacy Compadre bot.
- [x] Cut the official `Compadre` app over to
  `https://compadre-api.comprehensive.io/slack/events`. Two live canaries on
  2026-08-30 each produced exactly one final answer and one canonical web link;
  the final env-group canary persisted a completed central snapshot while the
  legacy relay received zero `/slack/events` requests.
- [ ] Finalize the production app description, privacy/terms links, support
  owner, and incident contact.
- [ ] After the rollback soak, disable or remove the temporary `Secret dre
  experiment` app and retire the legacy relay deliberately. Do not delete
  either while it is still part of the rollback plan.

## Identity, authorization, and audit

- [ ] Confirm the initial access policy: allowed-workspace membership grants
  access to all internal conversations, or implement thread/project membership
  before cutover.
- [ ] Backfill or lazily create canonical users for existing Slack senders while
  preserving stable workspace/user identity pairs.
- [ ] Attribute every Slack, browser, and API message to a trustworthy canonical
  actor and origin.
- [x] Preserve attribution on both initial thread hydration and live
  `thread.message-sent` events; verify a second user's web message is labeled
  correctly for another logged-in user.
- [ ] Authorize every thread read, send, cancel, approval, attachment, terminal,
  API, and administrative action on the server.
- [ ] Define behavior for deactivated Slack users, workspace guests, renamed
  accounts, email changes, and users removed from the workspace.
- [ ] Verify secure cookie flags, session expiry/rotation, logout revocation,
  CSRF protections, and rejection of legacy pairing browser sessions.
- [ ] Persist an audit trail for login, message creation, provider selection,
  tool approval, cancellation, and administrative changes.

## Durable data and recovery

- [ ] Inventory every copy of conversation and execution data: central T3
  SQLite, Compadre Postgres, Modal/provider transcripts, Slack, attachments,
  and Datadog.
- [ ] Make central T3 the authoritative transcript and reduce Postgres worker
  snapshots to narrow execution/recovery records.
- [x] Leave existing Compadre conversations in the frozen legacy deployment
  during the rollback window; no transcript migration is required for cutover.
- [ ] Add encrypted continuous backup for T3 SQLite and Postgres.
- [x] Add authenticated, integrity-checked online SQLite snapshots to the
  private Comprehensive S3 bucket and document the single-writer restore
  procedure in `docs/runbooks/central-t3-restore.md`.
- [ ] Run and time a restore into clean resources; verify thread text, tool
  calls, actor attribution, sessions, and external-thread bindings.
- [ ] Add SQLite integrity checks, disk-capacity alerts, backup-age alerts, and
  explicit RPO/RTO targets.
- [ ] Move attachments and large artifacts to durable object storage with
  authorization and retention policies.
- [x] Create the private `s3://compadre` bucket in Comprehensive AWS account
  `629591269808`, block public access, enable encryption and versioning, and
  grant the Render `compadre` identity `s3:GetBucketLocation`/`s3:ListBucket`
  plus `s3:GetObject`/`s3:PutObject` on `attachments/v1/*` only.
- [x] Set `COMPADRE_T3_ARTIFACT_BUCKET=compadre` and
  `COMPADRE_T3_ARTIFACT_REGION=us-west-2` on the Comprehensive production API
  service.
- [ ] After deploying the attachment implementation, verify byte-for-byte web
  download plus Slack upload from one generated artifact.
- [ ] Define deletion propagation across T3, Postgres, Modal/provider
  transcripts, object storage, Slack, and Datadog.
- [x] Add normalized, idempotent central usage records so model context, token
  totals, and costs do not depend on worker-local transcript files.

## Execution and feature parity

- [ ] Run the complete old-Compadre capability audit against browser, Slack,
  and API entrypoints.
- [ ] Verify native provider/model selection for Codex/OpenAI and Claude
  Code/Anthropic, including reasoning/context options and resume behavior.
- [ ] Verify MCPs, skills, prompts, custom tools, deployment/thread alerts, and
  installed/custom CLIs in both harnesses from one canonical configuration.
- [x] Verify relay API authentication, idempotency, central execution, durable
  status/replay, streaming, and cancellation on the isolated deployment.
- [ ] Soak the checked-in asynchronous `/prompt` caller and inventory any
  externally configured synchronous or webhook consumers before cutover.
- [x] Migrate `/webhook/:source` to the central native-T3 thread path with
  durable status/events and caller-supplied idempotency keys.
- [x] Inventory checked-in `/ag-ui` and `/workflow-runs` callers and migrate
  both wire contracts to central T3. No checked-in callers were found; retain
  the routes during a soak period for externally configured consumers.
- [ ] Preserve the old Slack automatic-continuation behavior when a harness run
  exits without a terminal answer, with a bounded retry and visible failure.
- [ ] Define durable completion semantics for asynchronous `/prompt` callers and
  report real turn, token, and cost data instead of placeholder values.
- [ ] Verify tool details in the T3 UI: actual arguments, results, MCP server and
  tool names, changed-file summaries, diffs, approvals, and failures.
- [ ] Verify terminal/shell lifecycle, attachments, checkpoints/reverts, pull
  requests, branch guards, and development-environment links.
- [ ] Route source-control and pull-request reads/actions to the thread's Modal
  checkout, or persist equivalent projections centrally. The hosted T3 server
  now has a supported `gh` binary, but its local Render workspace is not the
  isolated repository edited by the agent.
- [ ] Verify a conversation can start and resume from Slack, browser, or API
  without duplicate runs or divergent history.
- [ ] Prove controller-restart takeover after the durable-outbox fix with lease
  expiry, replacement claiming, stale-attempt fencing, concurrent claims, and
  exactly one idempotent delivery.
- [ ] Make Slack completion delivery durable across controller rollouts. A live
  2026-08-27 probe entered through a retiring controller while its central T3
  turn continued on the replacement instance; the old in-memory completion
  callback did not survive to post the result. The replacement implementation
  persists the delivery before waiting and lets a replacement controller claim
  it idempotently after the lease expires, but the post-fix rollout probe above
  remains required.
- [ ] Decide whether cancelled compatibility streams require an explicit
  terminal AG-UI chunk; durable status currently reaches `aborted`, while the
  event log closes after the last already-persisted event.

## Observability and operations

- [x] Keep one Datadog Agent/LLM Observability application for the logical
  Compadre product while retaining separate controller, central-T3, and worker
  APM service names.
- [x] Verify input/output content, model, provider, tokens, cost, latency, tool
  calls, user, thread, and entrypoint on sampled LLM spans.
- [ ] Add the controller run ID to the correlated central/worker LLM and APM
  spans so one run can be followed without joining logs manually.
- [ ] Verify W3C trace-context propagation across Slack/API request, central T3,
  controller, Modal worker, harness turn, tools, and persistence calls.
- [ ] Add dashboards and alerts for login failures, Slack retries, run failures,
  orphaned runs, stream reconnects, queue time, sandbox startup, model latency,
  token/cost anomalies, database latency, backup age, and disk usage.
- [ ] Write runbooks for Slack outage, provider outage, Modal failure, Render
  deploy failure, database restore, credential rotation, and stuck runs.
- [ ] Confirm logs and trace content are redacted, bounded, and covered by the
  intended retention policy.

## Cutover and rollback

- [ ] Run a production-like staging test matrix for Slack-started,
  browser-started, and API-started conversations with both harnesses.
- [ ] Test success, tool use, MCP use, file edits, pull request creation,
  cancellation, failure, reconnect, browser refresh, Slack retry, and resume
  from the other entrypoint.
- [ ] Run the new deployment in parallel with legacy Compadre for an agreed
  observation period and compare reliability, latency, cost, and output quality.
- [ ] Freeze configuration changes, take verified backups, rotate final
  production credentials, and record the exact deployed revisions.
- [ ] Switch a small allowlisted cohort first, then expand after reviewing
  telemetry and user feedback.
- [ ] Keep the legacy service and Slack routing recoverable during the rollback
  window. Document the exact traffic, event URL, and credential rollback steps.
- [ ] Define objective go/no-go thresholds and a single cutover owner.
- [ ] After the rollback window, revoke superseded credentials, remove obsolete
  services and duplicated persistence, archive migration artifacts, and update
  the architecture document to describe only the production system.

## Central SQLite to PostgreSQL migration (not yet executed)

Follow [the staged cutover runbook](./runbooks/central-t3-postgres-cutover.md).
The candidate Blueprint must not be synced before the approved import window.
Reuse the existing application database and credential, with central tables in
`compadre_t3` and controller tables in `public`; verify
shared capacity, backup/PITR/export and monitoring policy; verify the immutable SQLite audit snapshot and complete
attachment object import; prove one PostgreSQL canary with existing secrets and
environment identity. Retain the disk and single-process topology. Overlapping
reactor ownership/drain, an automated continuous rollout canary, configuration
ownership and checkpoint reconstruction remain gates before any disk removal.
Do not mark the zero-downtime TODO complete from SQL concurrency tests. Once
PostgreSQL accepts production writes, only PostgreSQL-compatible binary rollback
is allowed, with a 24-hour observation window and successful restore rehearsal.
