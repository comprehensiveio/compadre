# Production secrets

Render is the production configuration authority for Compadre today. Source
control owns variable names and non-secret values in `render.yaml`; linked
Render environment groups own secret values. Do not duplicate a shared secret
as a service-level variable because a direct service value takes precedence and
silently defeats group rotation.

The production project has three least-privilege groups:

- `compadre-production-shared` is linked to `compadre-api` and `compadre-web`.
  It owns only controller/web trust material and shared Datadog credentials.
- `compadre-production-api` is linked only to `compadre-api`. It owns Postgres,
  Modal, Slack, model-provider, MCP, AWS, GitHub, and integration credentials.
- `compadre-production-web` is linked only to `compadre-web`. It owns the
  repository-scoped GitHub credential and any web-only secret.

Public URLs, feature flags, service names, and telemetry labels stay in
`render.yaml`. The central T3 bearer, backup credential, auth-exchange secret,
and preview-gateway secret are each stored once in the shared group because
both services must receive exactly the same value. Worker processes receive
only the allowlisted subset projected by the controller; Modal is not a second
secret store.

The optional Codex subscription experiment uses three values in
`compadre-production-api`:

- `COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED=true`
- `CODEX_AUTH_JSON_BASE64`, the base64 encoding of the dedicated
  ChatGPT-managed Codex `auth.json`
- `COMPADRE_CODEX_AUTH_ENCRYPTION_KEY`, the base64 encoding of 32 random bytes

The controller serializes one subscription-backed Codex thread at a time.
Concurrent Codex threads use `OPENAI_API_KEY`. A thread's route is fixed while
its current run (including steers and retries) is active. Before handing the
subscription lane to another thread, the controller stops the old Codex
provider session, reads its refreshed auth file, encrypts that refresh chain in
Compadre Postgres, and changes the idle worker back to API auth. Auth bytes are
written through the Modal filesystem API and never placed in command arguments
or the T3 server environment.

Set `COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED=false` for an immediate
API-only kill switch. The metadata is namespaced under
`compadre.codex-subscription-lane.v1` and requires no schema migration; leaving
it in place is inert while disabled. Code rollback preserves the older startup
behavior when the flag is absent. Treat the source auth file, its encoded value,
and the encryption key like passwords. Never auto-clear an apparently stale
subscription owner: an uncertain owner intentionally sends all new work to the
API key until an operator confirms the old provider process is stopped.

Operational telemetry is emitted without credential contents:

- `Codex auth routing initialized` identifies legacy, managed API-only, or
  subscription-canary startup mode.
- `Codex auth route selected` includes `codexAuthRouteReason` so API fallback
  distinguishes a busy lane, the kill switch, an existing route, and a lane
  error.
- `Codex auth handoff phase completed|failed` identifies the exact stop, read,
  persist, configure, release, or reset phase and its duration. A failure with
  `codexLaneState=retained_for_safety` means new threads intentionally remain
  on API auth until an operator investigates; `released_worker_stopped` means
  the lane is available but an idle stopped worker still needs API reset on
  its next turn.
- `compadre.codex.auth.route.selections`,
  `compadre.codex.auth.handoff.phases`, and
  `compadre.codex.auth.handoff.duration` provide route counts, phase outcomes,
  and latency in Datadog.

The older Modal-side `compadre-t3-codex-auth-experiment` secret is not an auth
source while the flag is explicitly `true` or `false`; managed workers select
only the Render/Postgres subscription lane or the Render-projected API key.
Keep that Modal secret only as a short rollback bridge until the experiment is
accepted, then remove it so there is one unambiguous control plane.

## Rotation

1. Identify every consumer from the group links and the projection allowlist.
2. Create the replacement credential at the upstream provider.
3. Update its single Render group value. Render redeploys linked services.
4. Verify `/health`, Slack signature handling, browser login, and one provider
   turn before revoking the previous credential.
5. Record the owner, scope, provider, rotation date, and next review date in the
   internal credential inventory. Never record the value in Git, tickets,
   Slack, logs, or Datadog.

During the rollback window, the frozen legacy service keeps its original
environment groups. That is intentional temporary duplication, not an active
source of truth. Revoke and remove those groups only after the rollback window
closes.

Doppler can replace Render groups later without changing application code: keep
the same environment-variable contract, make Doppler the sole writer, validate
the rendered key inventory, and only then remove values from Render. Do not run
both systems as independent writable authorities.

## Central PostgreSQL production bindings

`compadre-web` receives `COMPADRE_T3_POSTGRES_URL` by referencing the existing
`compadre-postgres` private connection string. The controller and central T3
share its database and credential; controller tables stay in `public` and
central tables use `compadre_t3`. No new database password or
migration secret is required, and existing secret values are not rotated.
The approved cutover installed these web bindings on 2026-09-05. Temporal keeps its
separate database and credentials. Set `COMPADRE_T3_PERSISTENCE=postgres` and
`COMPADRE_T3_REACTOR_MODE=single-process` explicitly.

Set `COMPADRE_T3_ATTACHMENT_BUCKET=compadre` and
`COMPADRE_T3_ATTACHMENT_REGION=us-west-2`. Web S3 credentials need only
GetObject/PutObject for `attachments/v1/central-t3/*`. The Blueprint
references the controller’s existing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
on the web service; it does not generate or rotate them. The live web service reuses the controller’s existing key values; no other
service environment values or secret values were changed.
The central object prefix stays under the already-authorized `attachments/v1/`
path, so no IAM policy expansion is needed. The web binding does not change
worker credential configuration. Preserve the
existing disk's browser/asset/upload signing secrets and stable environment ID.
Their managed-secret migration is a disk-removal blocker. Do not retire
`COMPADRE_BACKUP_TOKEN` until both sides have switched and the final immutable
SQLite backup is archived. Follow the central PostgreSQL cutover runbook.
