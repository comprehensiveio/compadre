# Per-thread development environment operations

This runbook covers the dark-launched Comp development environment attached to
each hosted T3 thread. The safety and ownership rules in
`docs/dev-environment-guardrails.md` apply to every operation here.

## Architecture and lifecycle

- The Render controller hosts the durable thread/run APIs and the shared T3
  directory.
- Each thread owns one Modal sandbox containing its T3 server, native Codex or
  Claude Code harness, Comp checkout, PostgreSQL 16 cluster, Redis, Vite, and
  Chromium.
- Creating or chatting in a thread starts only T3 and the harness. PostgreSQL,
  Redis, dependency restoration, and Vite remain stopped until the agent runs
  `scripts/compadre-dev-up.sh up`.
- The idempotent `up`, `status`, `url`, and `down` commands are the supported
  lifecycle interface. The stable review URL remains attached to the thread
  while its sandbox exists.
- Review traffic enters through the hosted T3 service at
  `https://<canonical-thread-id>.dev.compadre.comprehensive.io`. The service
  requires a Comprehensive Slack-backed browser session, resolves the existing
  sandbox through a service-authenticated controller endpoint, and proxies HTTP
  and WebSocket traffic without exposing the raw Modal URL.
- Preview resolution never provisions a sandbox. A missing or expired thread
  sandbox returns an unavailable response instead of silently creating a new
  environment.
- The outer T3 session controls access to the preview. Comp's independent
  `connect.sid` cookie stays scoped to the thread host, so developers can still
  use Comp's synthetic dev-login routes to impersonate any seeded user inside
  the isolated environment.

## Comprehensive-owned artifacts

Before reading or replacing artifacts, verify AWS identity is account
`629591269808`. The only approved location is:

```text
s3://compadre/dev-environments/comp/
```

Current inputs are synthetic or derived build artifacts:

- `seed-latest.tar`: PostgreSQL 16-compatible synthetic Compadre Demo data.
- `deps-prebuilt-amd64-latest.tar.zst`: dependencies generated from the Comp
  lockfile and Prisma schema for the Modal x86 runtime.
- `pgdata-latest.tar.zst` and `vite-cache-latest.tar.zst`: optional caches. A
  missing object must degrade to the seed/dependency path rather than fail.

The controller signs read-only object URLs for no more than seven days and
projects those URLs only when the feature flag is enabled. Never upload a
production database dump or use a Tolt-owned bucket, account, or artifact.

Refresh a dependency artifact whenever the Comp lockfile, Prisma schema, Node
ABI, CPU architecture, or libc compatibility changes. Refresh the seed through
the isolated seed builder, verify that it contains no credentials or customer
data, and restore it into a disposable sandbox before publishing it as latest.

## Required validation

For an implementation or artifact change, validate this vertical slice against
the deployed Comprehensive canary:

1. Submit an authenticated asynchronous `/prompt` request that explicitly asks
   the agent to use the dev-environment skill.
2. Follow `/workflow-runs/:runId` until terminal and inspect the centralized T3
   snapshot; do not depend on Modal for transcript rendering.
3. Require a reported `DEV_ENV_READY`, review URL, and measured startup time
   under ten minutes.
4. From inside the sandbox, use system Chromium at `/usr/bin/chromium` with
   agent-browser against localhost and verify a page-specific signal after the
   synthetic dev login.
5. From outside the sandbox, verify the public URL, its login redirect, the
   synthetic dev-login 302, its session cookie, and the authenticated page.
6. Confirm the review URL remains reachable after the agent turn completes.
7. Run Compadre tests, typecheck, build, and `git diff --check` before a canary
   deploy.

The first deployed end-to-end validation on 2026-08-30 completed successfully:

- full API-to-terminal run: 480.748 seconds, including an uncached Modal image
  resolution and MCP startup;
- Comp environment startup: 160.761 seconds;
- synthetic login: HTTP 302 with a session cookie;
- authenticated `/company/employees`: HTTP 200 with the expected page title;
- public review URL: still reachable after the run completed.

After adding the complete synthetic exchange-rate set, the replacement seed was
restored into a disposable PostgreSQL 16 sandbox before publication. The gate
found 1,346 users, 158 exchange rates including USD to MXN, and zero partner or
integration credentials. S3 bucket versioning retained the prior artifact; the
validated replacement is version `3EWJAqE1h46DgzpkdQUgQCq4m0RDvUHG` with SHA-256
`3017c168ed1687e25a192c7dd6f6acfb6d918c1adfe41dea8eb25ae4211a4871`.

A fresh post-publication deployed run also completed successfully:

- run `dev-env-live-e042da88-03f1-466e-a88f-debd59bff39b` completed in
  361.468 seconds API-to-terminal;
- Comp environment startup: 154.131 seconds;
- system Chromium loaded the authenticated Employees grid and reported
  `Rows: 1346`, with no application error boundary;
- independent host-side checks observed root HTTP 307, dev-login HTTP 302 with
  a session cookie, and authenticated `/company/employees` HTTP 200 with title
  `Comprehensive - Employees`;
- the public review URL remained reachable after the provider turn completed.

The authenticated-gateway validation on 2026-08-30 used a newly provisioned
thread rather than a historical sandbox:

- canonical thread `ac93ef79-5f64-4072-9b38-d70cf1f23381` completed in 380
  seconds API-to-terminal;
- the agent started the lazy Comp environment, used system Chromium, logged in
  as the synthetic admin, and observed 1,346 employee rows;
- the stable preview host redirected unauthenticated GET requests to the
  restricted Slack login and rejected unauthenticated POST requests with HTTP
  401;
- the controller resolved the exact existing sandbox, while an expired earlier
  sandbox returned unavailable and did not cause replacement provisioning;
- the Render wildcard domain and TLS certificate were verified, and the main
  UI, session endpoint, and controller health endpoint all returned HTTP 200.

## Security boundary

The raw random Modal URL remains a bearer-style routing capability and must stay
inside the controller-to-UI trust boundary. Users receive only the stable
authenticated thread URL. The gateway strips its own T3 session cookie before
forwarding, keeps Comp's synthetic-user session separate, and accepts only UUID
thread subdomains under the configured preview suffix.
