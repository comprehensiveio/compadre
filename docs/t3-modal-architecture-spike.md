# T3-in-Modal architecture spike

## Outcome

Running T3's headless server inside a Modal sandbox is feasible and promising.
T3 can own native Codex and Claude execution, model selection, streaming events,
and terminal lifecycle while Compadre remains the gateway for browser, Slack,
API, durable environment allocation, and company-specific tools.

The spike runs in the isolated `compadre-t3-experiment` Modal app. It does not
change the production Compadre service.

## Proven locally

- The published T3 server runs inside the existing Modal image and serves its
  complete web client through a Modal encrypted HTTP/WebSocket tunnel.
- T3 pairing and authenticated WebSocket reconnect work across that tunnel.
- The private `comprehensiveio/comp` repository clones into `/workspace`, and
  T3 starts with that project already registered.
- T3's native model picker discovers both Codex and Claude. Codex API-key login
  is bootstrapped in the sandbox instead of being represented as a Compadre
  provider.
- A native Codex GPT-5.6-Sol turn used the repository and completed normally.
- A native Claude Opus 5 turn used Claude's Bash tool and completed normally.
- Both runs returned to T3's terminal state (`Worked for …`, normal send button,
  no stale stop control).
- The same Compadre skill sources can be projected into `.agents/skills` for
  Codex and `.claude/skills` for the published Claude integration.
- The T3 fork now accepts one `COMPADRE_MCP_URL`/bearer-token pair and injects
  it into both native adapters without replacing T3's own per-thread MCP.
- Compadre exposes its existing provider-neutral MCP/custom-tool inventory at
  the authenticated, environment-lived `/internal/t3-mcp` endpoint. A
  dedicated `COMPADRE_T3_MCP_BEARER_TOKEN` is preferred; the isolated
  experiment can fall back to its existing `COMPADRE_API_KEY`.
- The deployed experiment advertised 329 gateway tools. Native Codex and
  Claude Opus each called the same read-only `render_list_services` tool through
  that bridge and returned the live Compadre-related services. Both also saw
  the custom `slack_watch_comp_pr_deployment` schema without invoking it.
- T3 must run as the image's unprivileged `node` user. Claude intentionally
  rejects full-access mode when its process runs as root.
- Git credentials can remain process-environment configuration, allowing T3's
  background fetch and later pushes without writing a credentialed remote URL.
- Compadre now has a narrow authenticated T3 orchestration client for snapshots,
  thread creation, turn dispatch, terminal polling, and interruption. It uses
  T3's supported HTTP API for commands instead of vendoring T3's private Effect
  RPC client packages.
- A live gateway probe created a Codex thread, received
  `comprehensiveio/comp`, restarted the local gateway process, reconnected to
  the same Modal sandbox and T3 thread, and received `RECONNECTED` on a second
  turn. A separate provider-specific gateway probe created a native Claude
  Opus 5 thread and returned the same repository identity.
- Human browser pairing and the Compadre gateway use separate credentials. The
  reconnect credential is mode `0600` inside the isolated Modal sandbox rather
  than in generic thread metadata; the one-time browser token remains safe to
  consume independently.
- Terminal polling correlates the dispatched user message with the latest T3
  turn. This avoids accepting a previous completed turn during the short
  projection window after a new dispatch.

## Important constraints

### Threads are provider-bound

T3 permits model changes inside one provider, but an existing Codex thread
cannot switch to Claude and vice versa. A Compadre/Slack thread therefore needs
either:

1. one T3 thread per provider, with Compadre choosing the appropriate child;
   or
2. an explicit cross-provider fork that replays a provider-neutral transcript
   into a new T3 thread.

The first option matches T3's native architecture and should be the initial
implementation.

### Shared MCPs and custom tools belong at the gateway

Compadre already has one provider-neutral MCP inventory, including its Slack
server and durable `watch_comp_pr_deployment` tool. The preferred hosted shape
is one authenticated, environment-scoped HTTP MCP bridge on the Compadre
gateway. T3 should inject that bridge into both native adapters alongside its
own `t3-code` MCP.

This preserves a single configuration and credential boundary:

```text
Slack / browser / API
        |
Compadre gateway ---- company MCPs + custom durable tools
        |                         ^
        | T3 HTTP + WebSocket     | one authenticated HTTP MCP
        v                         |
T3 server in Modal ---------------+
        |
        +-- native Codex app-server
        +-- native Claude Agent SDK
```

The existing run-scoped TanStack tool bridge is close to the required server,
but the T3 version should be environment-scoped and live for the T3 server's
lifetime. A small T3-fork extension can read one external MCP URL/token from its
environment and merge it into both adapters. This is preferable to maintaining
separate `.mcp.json` and Codex TOML files containing credentials.

### State and routing

- One durable environment record owns the Modal sandbox ID, tunnel URL, and T3
  environment identity. The gateway credential remains in the sandbox and is
  recovered through Modal's authenticated filesystem API on reconnect.
- T3's SQLite state and provider sessions live inside the sandbox filesystem.
  Snapshot/restore must preserve that data and issue a fresh tunnel route when
  the sandbox wakes.
- Browser, Slack, and API messages should all enter through the gateway. The
  implemented command/snapshot path uses T3's authenticated orchestration HTTP
  API; live fan-out will use T3's event subscription. Slack rendering is a
  projection of the same T3 state the browser receives, not a second agent run.
- Disconnecting a browser or Slack request must not cancel a T3 turn. Explicit
  cancellation should send T3's cancel command and wait for its terminal event.

## Other parity seams to configure once

| Concern | Canonical owner | Native projection |
| --- | --- | --- |
| Skills | Compadre repository | Copy to `.agents/skills` and `.claude/skills` |
| MCPs and custom tools | Compadre gateway | One authenticated HTTP MCP injected into both adapters |
| Base instructions | Compadre/project config | `AGENTS.md` plus Claude-compatible instruction projection |
| Slack turn context | Compadre gateway | Prepend channel/thread coordinates to the T3 user turn |
| Provider credentials | Modal environment secrets | Native Codex login and Claude environment |
| Git/GitHub credentials | Modal environment secrets | Git config environment and `GH_TOKEN` |
| Installed CLIs | Modal image | Pinned T3, Codex, Claude, `gh`, `jq`, `rg`, Postgres client, and app-specific CLIs |
| Attachments | Compadre gateway + sandbox filesystem | Upload once, reference sandbox paths in the T3 turn |
| Run status/cancellation | T3 event stream | Gateway stores terminal state and fans it out to every surface |
| Deployment follow-up | Compadre durable tool service | Exposed through the shared MCP bridge |

## Current gateway slice

- `T3Client` exchanges pairing credentials, dispatches supported HTTP commands,
  reads snapshots, interrupts turns, and waits for the exact dispatched turn.
- `T3Gateway` maps a provider-neutral conversation to one provider-native T3
  thread and routes repeat messages, cancellation, and terminal waits.
- `T3ThreadBindingStore` persists credential-free provider-specific mappings.
- `T3ModalEnvironmentManager` provisions one isolated environment per mapping,
  reconnects after a gateway restart, and destroys failed first-turn sandboxes.

## Recommended next slice

1. Add a live subscription adapter for T3 thread events so Slack and the API can
   stream without polling snapshots.
2. Route the existing API endpoint through `T3Gateway` behind an experiment
   flag, preserving its current request and response contract.
3. Route the Slack simulator through the same gateway and prove browser,
   Slack, and API transcript consistency.
4. Package the forked T3 server as a reproducible Modal image artifact. The
   local spike currently accepts `COMPADRE_T3_PACKAGE_PATH` to overlay a tested
   tarball.

TanStack AI does not need to own harness execution on this path. The spike still
reuses `@tanstack/ai-sandbox` as a convenient provisioning wrapper around Modal;
that can remain as infrastructure or be replaced later without affecting T3's
native provider ownership.
