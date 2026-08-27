# Production cutover checklist

This is the running checklist for replacing the current Compadre deployment
with the hosted T3 architecture. Keep it current as the internal deployment
reveals new requirements. A checked item means it was demonstrated in the
isolated deployment, not that the equivalent production change has been made.

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
- [x] Completed provider events can be replayed from the central event log.
- [x] Datadog receives one Agent/LLM Observability application while controller
  and worker remain distinct APM services.

## Release and infrastructure

- [ ] Decide the final production service names and hostnames for central T3,
  the controller, Postgres, and the persistent T3 disk.
- [ ] Create production resources independently of the existing Compadre
  service so traffic can be switched gradually and rolled back.
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
  active turns, and verify that no Modal run is orphaned.
- [ ] Keep one central T3 writer and one controller instance until distributed
  ownership, leases, fencing, and command delivery are implemented.
- [ ] Define capacity limits and alerts for the Render services, Postgres,
  persistent disk, and concurrent Modal sandboxes.

## Production secrets and configuration

Create fresh production credentials. Do not promote or reuse credentials from
the isolated deployment.

Controller secrets and configuration:

- [ ] `DATABASE_URL`
- [ ] `COMPADRE_T3_CENTRAL_URL`
- [ ] `COMPADRE_T3_CENTRAL_TOKEN`
- [ ] `COMPADRE_AUTH_EXCHANGE_SECRET`
- [ ] `COMPADRE_SLACK_WORKSPACE_ID`
- [ ] `SLACK_CLIENT_ID`
- [ ] `SLACK_CLIENT_SECRET`
- [ ] `SLACK_SIGNING_SECRET`
- [ ] `SLACK_BOT_TOKEN`
- [ ] `SLACK_OIDC_REDIRECT_URI`
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
- [ ] `VITE_COMPADRE_AUTH_ENABLED=true`
- [ ] Persistent SQLite path and disk mount
- [ ] Ensure the retired `COMPADRE_PROVIDER_URL` is unset

For every secret, record its owner, scope, storage location, rotation procedure,
and last-rotated timestamp. Verify that no credential reaches the browser,
central transcript, Modal logs, Datadog content, or source control.

## Slack application

- [ ] Decide whether to update the current Compadre Slack app or create a new
  production app and migrate installations.
- [ ] Set the production event request URL to `/slack/events` and pass Slack's
  verification challenge.
- [ ] Add the exact production `/auth/slack/callback` redirect URL.
- [ ] Configure Sign in with Slack scopes: `openid`, `profile`, and `email`.
- [ ] Reconcile bot scopes and events with the checked-in manifest, including
  mentions, DMs, channel history, message writing, reactions, and user lookup.
- [ ] Reinstall/reauthorize the app after scope changes and confirm the bot is in
  every required channel.
- [ ] Verify signing-secret validation, replay-window enforcement, event
  idempotency, Slack retry handling, and installation-specific bot identity.
- [ ] Verify that every Slack thread link uses the canonical central T3 project
  and thread IDs and opens the correct transcript after login.
- [ ] Verify Slack progress/status updates for native tools and MCP tools, final
  success, failure, cancellation, and resumed runs.
- [ ] Decide the production app name, icon, description, privacy/terms links,
  support owner, and incident contact.

## Identity, authorization, and audit

- [ ] Confirm the initial access policy: allowed-workspace membership grants
  access to all internal conversations, or implement thread/project membership
  before cutover.
- [ ] Backfill or lazily create canonical users for existing Slack senders while
  preserving stable workspace/user identity pairs.
- [ ] Attribute every Slack, browser, and API message to a trustworthy canonical
  actor and origin.
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
- [ ] Define whether existing Compadre conversations are imported, linked
  read-only, or left in the legacy deployment during a retention window.
- [ ] Add encrypted continuous backup for T3 SQLite and Postgres.
- [ ] Run and time a restore into clean resources; verify thread text, tool
  calls, actor attribution, sessions, and external-thread bindings.
- [ ] Add SQLite integrity checks, disk-capacity alerts, backup-age alerts, and
  explicit RPO/RTO targets.
- [ ] Move attachments and large artifacts to durable object storage with
  authorization and retention policies.
- [ ] Define deletion propagation across T3, Postgres, Modal/provider
  transcripts, object storage, Slack, and Datadog.
- [ ] Add normalized, idempotent central usage records so model context, token
  totals, and costs do not depend on worker-local transcript files.

## Execution and feature parity

- [ ] Run the complete old-Compadre capability audit against browser, Slack,
  and API entrypoints.
- [ ] Verify native provider/model selection for Codex/OpenAI and Claude
  Code/Anthropic, including reasoning/context options and resume behavior.
- [ ] Verify MCPs, skills, prompts, custom tools, deployment/thread alerts, and
  installed/custom CLIs in both harnesses from one canonical configuration.
- [ ] Verify relay API compatibility, authentication, idempotency, error shape,
  streaming, cancellation, and existing callers.
- [ ] Verify tool details in the T3 UI: actual arguments, results, MCP server and
  tool names, changed-file summaries, diffs, approvals, and failures.
- [ ] Verify terminal/shell lifecycle, attachments, checkpoints/reverts, pull
  requests, branch guards, and development-environment links.
- [ ] Verify a conversation can start and resume from Slack, browser, or API
  without duplicate runs or divergent history.
- [ ] Implement or explicitly defer controller-restart takeover with persisted
  dispatch metadata, heartbeats, leases, and epoch fencing.

## Observability and operations

- [ ] Keep one Datadog Agent/LLM Observability application for the logical
  Compadre product while retaining separate controller, central-T3, and worker
  APM service names.
- [ ] Verify input/output content, model, provider, tokens, cost, latency, tool
  calls, user, thread, run, and entrypoint on sampled LLM spans.
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

