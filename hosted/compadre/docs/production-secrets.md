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
