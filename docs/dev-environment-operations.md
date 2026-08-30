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
  lifecycle interface. The public review URL remains attached to the live
  thread sandbox between turns.

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

## Security boundary

The random Modal URL is encrypted in transit but is still a bearer-style link,
not an authenticated perimeter. Keep it inside the originating internal
Compadre conversation. An authenticated preview gateway is a prerequisite for
external or broad multi-tenant use.
