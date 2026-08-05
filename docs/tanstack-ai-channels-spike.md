# Provider-neutral agent runtime

## Current shape

Compadre now has a channel-neutral conversation module in front of both the
existing Claude Agent SDK implementation and the TanStack harness runtime:

```text
Slack ---------\
                > runConversation() ---- legacy Claude Agent SDK
/prompt -------/           |
                           +------------- TanStack AI
                                           /      \
                                    Claude Code   Codex

web/other AG-UI clients -------------------^
```

`runConversation()` owns worktree allocation, provider-native sessions,
provider-neutral transcript continuity, per-thread serialization, cancellation,
stream callbacks, result metrics, and cleanup. Slack and `/prompt` no longer
need to understand those details.

The legacy runtime remains the default and rollback path. The existing Slack
event ingestion, signature checks, production-support link forwarding, thread
context construction, reactions, and rendering are unchanged.

## Enable the provider-neutral runtime

```dotenv
# legacy or tanstack
COMPADRE_AGENT_RUNTIME=tanstack

# claude-code or codex
COMPADRE_AGENT_PROVIDER=codex

# Hard wall-clock limit. Defaults to 15 minutes.
COMPADRE_AGENT_MAX_DURATION_MS=900000

ANTHROPIC_API_KEY=...
DEFAULT_MODEL=claude-opus-5
FABLE_MODEL=claude-fable-5

OPENAI_API_KEY=...
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=high
```

This switches both Slack and `/prompt`. `/prompt` may select `provider` per
request when the TanStack runtime is enabled. Provider-native `sessionId` is
legacy-only; TanStack callers use `threadId`, which survives provider switches.

To canary the real Slack Events path without changing other users, leave the
global runtime on `legacy` and configure a comma-separated user allowlist:

```dotenv
COMPADRE_AGENT_RUNTIME=legacy
COMPADRE_AGENT_PROVIDER=codex
COMPADRE_TANSTACK_SLACK_USER_IDS=U0123456789
```

While the allowlist is non-empty, only listed Slack users use TanStack and all
other Slack users remain on the legacy runtime. Remove it to return entirely to
the configured global runtime.

Startup fails fast for invalid runtime or provider names. Both harnesses have a
wall-clock limit; Claude also enforces the configured turn count. The current
TanStack Codex adapter does not enforce turn count, and neither harness adapter
can enforce Compadre's dollar budget. Those limits are not required for cutover;
results retain `budgetEnforced` only for compatibility and observability.

## Enable AG-UI

```dotenv
COMPADRE_TANSTACK_AI_ENABLED=true
COMPADRE_API_KEY=...
```

`POST /ag-ui` accepts a standard AG-UI `RunAgentInput` and returns TanStack's
AG-UI SSE response. It independently supports per-request provider selection:

```json
{
  "forwardedProps": {
    "provider": "codex"
  }
}
```

Only allowlisted provider, model, Fable, and max-turn fields affect the harness;
arbitrary `forwardedProps` cannot replace adapters or tools.

Claude and Codex share the same system prompt, MCP sources, worktree, abort
signal, Datadog span, and channel stream. Their native session IDs remain
provider-scoped. Direct conversation callers also retain a bounded
provider-neutral transcript, so switching providers starts a fresh native
session with the intervening turns instead of resuming stale provider context.

## Verified behavior

- Existing Slack and prompt behavior passes the full regression suite with the
  legacy runtime still defaulted.
- Claude and Codex both produce valid AG-UI streams through the shared runtime.
- Same-provider native session resume works for both harnesses.
- The production-shaped `runConversation()` path passed live
  Claude -> Codex -> Claude switches while retaining a value across both
  switches.
- Stream text, tool starts, terminal errors, provider session IDs, usage, and
  cleanup translate into the existing Compadre callback/result interface.
- Codex progress messages remain available to raw AG-UI clients, while Slack
  and `/prompt` publish only the terminal assistant message.
- TanStack's OpenTelemetry middleware emits provider-neutral agent, model,
  token/cache/reasoning usage, duration, error, and harness-tool spans through
  Datadog. Claude's provider-reported cost is normalized to `usage.cost`;
  Codex cost remains provider-estimated from model and token metadata.
- One-shot `/prompt` worktrees and state are released; threaded conversations
  retain their worktree and provider sessions.
- Fresh TanStack worktrees run the comp repo's provider-neutral setup before a
  harness starts, so Codex receives the same dependency and generated-client
  preparation previously triggered only by Claude's SessionStart hook.
- A production-shaped fresh linked-worktree smoke test ran the linked Vite
  binary under Codex and completed with no tracked worktree changes.
- TanStack-generated local projection markers are removed at stream teardown.
- MCP connection failures are logged and skipped; connected clients are owned
  and closed by `chat({ mcp })`.

## Provider-neutral instructions

TanStack Intent is installed as a development dependency and generated
`AGENTS.md` mappings for the exact installed TanStack versions. Relevant
guidance changed the implementation to use TanStack's MCP and workspace setup
lifecycles.

Compadre's three domain workflow files are also identified by absolute path in
the system prompt. Claude can continue using its plugin command; Codex and other
harnesses can read the same `SKILL.md` sources directly. This provides portable
workflow parity without writing `AGENTS.md`, `.claude`, or `.codex` files into
the target monorepo.

## Deliberately deferred durability

Postgres is not part of this implementation. The asynchronous
`HarnessThreadStore` currently persists in process:

```text
thread ID
  -> shared worktree ID
  -> bounded provider-neutral transcript
  -> Claude Code session ID
  -> Codex session ID
  -> last provider
```

The next durability milestone should combine:

- a Postgres adapter for `HarnessThreadStore`;
- `@tanstack/ai-persistence` stores for messages, runs, interrupts, and metadata;
- a distributed `LockStore` for multi-instance single-writer safety;
- persistent/shared worktree and provider session storage, or a durable remote
  sandbox.

Postgres alone does not make native Claude/Codex session directories or git
worktrees portable between hosts.

## Remaining considerations

- TanStack's Claude adapter supports `maxTurns` but not `maxBudgetUsd`; its
  Codex adapter supports neither limit. Wall-clock enforcement is implemented,
  and the missing provider limits are an accepted tradeoff rather than a
  cutover blocker.
- Claude streams token deltas; the Codex adapter currently emits completed
  message bursts. Slack renders both, but the typing experience differs.
- Provider-neutral workflow files cover Compadre's critical operational rules,
  but the full Claude local-plugin behavior is not projected into Codex.
- Required-versus-optional MCP policy is not yet explicit. During local smoke
  testing unavailable or placeholder MCP credentials were correctly skipped.
- The dependency footprint remains significant: the pinned Codex native binary
  is about 310 MB on macOS.
- `@tanstack/ai-sandbox-local-process` provides lifecycle plumbing, not host
  isolation. Codex also uses its `workspace-write` sandbox; Claude retains the
  existing bypass-permissions trust posture.

## Recommended rollout

1. Deploy with `COMPADRE_AGENT_RUNTIME=legacy` and AG-UI off.
2. Set `COMPADRE_AGENT_PROVIDER=codex` and canary selected Slack users through
   `COMPADRE_TANSTACK_SLACK_USER_IDS` while the global runtime remains legacy.
3. Expand the allowlist after MCP, workflow, telemetry, and output quality hold
   under real Slack traffic.
4. Remove the allowlist and make TanStack the production default.
5. Add Postgres persistence and distributed locking as a separate milestone.
