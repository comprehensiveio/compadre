---
name: dev-environment
description: Start and validate the Comp application's isolated development server when a task needs a live review environment or browser verification.
---

# Comp development environment

This thread owns one isolated Modal sandbox and checkout. Postgres, Redis, Vite,
and Chromium are installed but deliberately stopped until a live environment is
useful. Do not start them for questions, investigations, or code changes that do
not benefit from browser validation.

## Start or reuse it

From `REPO_PATH`, run:

```bash
scripts/compadre-dev-up.sh up
```

The command is idempotent. It starts the sandbox-local Postgres and Redis,
restores the sanitized Comprehensive development data and prebuilt dependencies
when needed, launches Vite, verifies the preview host routing and dev-login
route locally, and prints the encrypted public review URL. It must finish within
ten minutes or fail with the relevant log tail.

Other lifecycle commands:

```bash
scripts/compadre-dev-up.sh status
scripts/compadre-dev-up.sh url
scripts/compadre-dev-up.sh down
```

Never substitute a production database or run a production dump command. The
artifact URLs supplied to this sandbox are short-lived and read-only.

## Validate with agent-browser

Before the first browser command in a turn, load the CLI workflow:

```bash
agent-browser skills get core
```

Modal does not support reaching a sandbox's public tunnel from that same
sandbox. Use localhost for agent-browser self-validation, and use the URL
printed by `scripts/compadre-dev-up.sh url` only when handing the environment to
the user. Log in through the sandbox-only route rather than typing credentials:

```bash
BASE_URL=http://127.0.0.1:${COMPADRE_DEV_PORT:-3000}
agent-browser open "$BASE_URL/api/v1/auth/dev/login/admin?company=Compadre%20Demo&redirect=/company/employees"
agent-browser wait --load domcontentloaded
```

Wait for a positive page-specific signal; never wait for `networkidle` because
Vite keeps an HMR websocket open. Save useful screenshots under
`/tmp/agent-outputs/` so Compadre can publish them as turn artifacts.

After changing application code, use this environment when visual or behavioral
proof is material, and include the running review URL in the final response.
Treat it as an internal link and do not publish it outside the originating
Compadre conversation.
