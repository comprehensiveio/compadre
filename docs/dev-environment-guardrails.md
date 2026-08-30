# Per-thread development environment guardrails

This document records the constraints for the Compadre development-environment
work so they survive handoffs and context compaction.

## Safety and ownership

- Toltagent is read-only prior art. Do not mutate any Toltagent repository,
  deployment, cloud account, bucket, secret, Slack app, or other resource.
- Create and use only Comprehensive/Compadre resources. Verify the organization
  or account before every external mutation.
- Keep the feature dark-launched and isolated on reversible branches and
  checkpoints until explicit approval to cut it over.
- Canary services may be rebuilt or redeployed. Avoid risky or irreversible
  production changes; defer any such operation for explicit approval.

## Product behavior

- A Compadre thread gets its own isolated development environment.
- Provisioning is lazy: ordinary conversations must not allocate development
  resources. Provision only when the agent actually needs a running app.
- Target a comfortably sub-10-minute cold start; a roughly 45-minute start is
  not useful.
- Support the main TanStack Start application only. Ignore Temporal, PIE, and
  auxiliary Toltagent services.
- The agent can start the app, expose it through a random TLS preview URL, validate
  it with agent-browser, and use an isolated database behind it.
- Learn from Toltagent's current production flow, including its Modal microVM
  and database choices where those fit Compadre's architecture. Do not assume
  older Claude-tag development-environment relics in Comp are good prior art.

## Delivery sequence

1. Finish and checkpoint the current reliability/correctness work.
2. Create an isolated Comp branch for any application changes.
3. Implement a minimal end-to-end vertical slice, measure cold-start latency,
   and verify it programmatically in deployed Comprehensive canaries.
4. Preserve useful unit/integration tests and remove temporary test harnesses.

## Runtime boundary

- Modal's per-thread sandbox is the isolation boundary. T3 and its native
  harness run as the sandbox root user so the lazy command can start the
  sandbox-local PostgreSQL and Redis services. Modal enforces `no_new_privs`,
  so dropping to an internal user and later using sudo is not viable.
- Root is scoped to that disposable sandbox. Each thread has a separate
  checkout, process tree, database, tunnel, and filesystem snapshot.
- Bootstrap inputs are synthetic or sanitized, read-only S3 objects in AWS
  account `629591269808`, bucket `compadre`, prefix
  `dev-environments/comp/`. Never substitute a Tolt resource or production
  database dump.
- The Modal preview is a random TLS tunnel, not an authenticated perimeter.
  Treat review URLs as internal bearer links and do not publish them outside
  the originating Compadre conversation. Add an authenticated preview gateway
  before any external or broadly multi-tenant use.
