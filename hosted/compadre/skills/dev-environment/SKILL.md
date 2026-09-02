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

Synthetic data is the default. Only when the user explicitly asks for current,
production-derived data, run:

```bash
scripts/compadre-dev-data.sh production-latest
```

That supported path requests the newest Comprehensive hourly backup through a
thread-scoped controller manifest, then reuses Hen to restore, anonymize, and
migrate the sandbox-local database. It deletes the raw dump and restarts the
same stable preview URL. Check the active mode with
`scripts/compadre-dev-data.sh status`. Never connect Hen directly to production,
set `HEN_SKIP_ANONYMIZE=true`, select another bucket, or use any Tolt resource.
The artifact and download URLs supplied to this sandbox are short-lived and
read-only.

## Validate with agent-browser

Before the first browser command in a turn, load the CLI workflow:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
agent-browser skills get core
```

Keep `AGENT_BROWSER_EXECUTABLE_PATH` set for every agent-browser command. The
development image installs Debian's system Chromium at that exact path; do not
fall back to a Playwright cache path or download another browser at runtime.

Modal does not support reaching a sandbox's public tunnel from that same
sandbox. Use localhost for agent-browser self-validation, and use the URL
printed by `scripts/compadre-dev-up.sh url` only when handing the environment to
the user. Log in through the sandbox-only route rather than typing credentials:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
BASE_URL=http://127.0.0.1:${COMPADRE_DEV_PORT:-3000}
LOGIN_COMPANY=$(cat /var/tmp/compadre-dev-login-company 2>/dev/null || printf 'Compadre Demo')
agent-browser open "$BASE_URL/api/v1/auth/dev/login/admin?company=$LOGIN_COMPANY&redirect=/company/employees"
agent-browser wait --load domcontentloaded
```

Wait for a positive page-specific signal; never wait for `networkidle` because
Vite keeps an HMR websocket open. Save useful screenshots under
`/tmp/agent-outputs/` so Compadre can publish them as turn artifacts.

After changing application code, use this environment when visual or behavioral
proof is material, and include the running review URL in the final response.
Treat it as an internal link and do not publish it outside the originating
Compadre conversation.
