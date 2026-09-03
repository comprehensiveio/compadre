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
