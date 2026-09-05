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
proof is material.

## Give the user an authenticated review link

When the environment is running, proactively include a complete Comp dev-login
URL in the response rather than the bare preview origin. The user needs Comp's
inner development session in addition to the outer Compadre session. Links
using `auto_impersonate` are not valid review links for this environment.

Build the link on the origin printed by `scripts/compadre-dev-up.sh url`, using
the identity most relevant to the conversation:

1. If the user named a specific sandbox-local user, look up that user's UUID.
2. Otherwise, infer the role, permissions, company, and representative data
   that best demonstrate the functionality the thread is about, then find a
   sandbox-local user who matches. Company context should constrain this choice;
   it does not imply that an admin is always the best reviewer.
3. For either contextual choice, use
   `/api/v1/auth/dev/login/user?userId=<uuid>&redirect=<path>`.
4. Only when the thread does not provide enough context to choose a meaningful
   user, use the stable fallback admin at company ID `9` with
   `/api/v1/auth/dev/login/admin?company=9&redirect=<path>`.

Default the redirect to `/`, or use the page that is most relevant to the work.
URL-encode every query value. For example, the fallback link is:

```text
https://<canonical-thread-id>.dev.compadre.comprehensive.io/api/v1/auth/dev/login/admin?company=9&redirect=%2F
```

If the user later asks to review as a particular person, return a new `/user`
dev-login link for that sandbox-local user. Treat every review link as internal
and do not publish it outside the originating Compadre conversation.
