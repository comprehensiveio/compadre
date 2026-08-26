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
- T3 must run as the image's unprivileged `node` user. Claude intentionally
  rejects full-access mode when its process runs as root.
- Git credentials can remain process-environment configuration, allowing T3's
  background fetch and later pushes without writing a credentialed remote URL.

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
        | T3 WebSocket            | one authenticated HTTP MCP
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

- One durable environment record must own the Modal sandbox ID, tunnel URL,
  T3 environment identity, and gateway authentication material.
- T3's SQLite state and provider sessions live inside the sandbox filesystem.
  Snapshot/restore must preserve that data and issue a fresh tunnel route when
  the sandbox wakes.
- Browser, Slack, and API messages should all enter through the gateway and use
  T3's typed WebSocket protocol. Slack rendering is a projection of the same
  T3 events the browser receives; it is not a second agent run.
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

## Recommended next slice

1. Package the forked T3 server as a reproducible Modal image artifact. The
   local spike accepts `COMPADRE_T3_PACKAGE_PATH` to overlay a tested tarball.
2. Implement a Compadre T3 WebSocket client that can create/select a native
   thread, submit a turn, subscribe/reconnect, and cancel.
3. Route the existing API endpoint and Slack simulation through that client.
4. Persist the Slack thread to provider-specific T3 thread mapping and prove
   browser/Slack/API consistency across a sandbox restart.

TanStack AI does not need to own harness execution on this path. The spike still
reuses `@tanstack/ai-sandbox` as a convenient provisioning wrapper around Modal;
that can remain as infrastructure or be replaced later without affecting T3's
native provider ownership.
