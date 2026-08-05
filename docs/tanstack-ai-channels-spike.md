# Provider-neutral agent runtime

## Current shape

All Compadre agent traffic runs through one channel-neutral conversation
boundary and the TanStack AI harness runtime:

```text
Slack events ----\
/slack -----------+--> runConversation() --> TanStack AI --> Claude Code
/prompt ----------+                                  \-----> Codex
/webhook/:source -/

AG-UI clients ---------------------------> the same TanStack runtime
```

`runConversation()` owns per-thread serialization, ephemeral-run cleanup,
provider selection, wall-clock cancellation, stream callbacks, and result
metrics. The TanStack runtime owns worktrees, provider-scoped native sessions,
provider-neutral transcript continuity, MCP clients, and telemetry.

## Configuration

```dotenv
# claude-code or codex
COMPADRE_AGENT_PROVIDER=claude-code

# Hard wall-clock limit. Defaults to 15 minutes.
COMPADRE_AGENT_MAX_DURATION_MS=900000

ANTHROPIC_API_KEY=...
DEFAULT_MODEL=claude-opus-5
FABLE_MODEL=claude-fable-5

CODEX_API_KEY=...
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=high
```

Startup fails fast for an invalid provider. `/prompt` may select `provider` per
request. Callers use the provider-neutral `threadId`; provider-native
`sessionId` values are internal and cannot be supplied through `/prompt`.

Both harnesses run non-interactively with approval prompts disabled. Claude
uses `bypassPermissions`; Codex uses `danger-full-access`, `approvalPolicy:
never`, and automatic MCP approval. This service therefore assumes its process,
credentials, prompts, and configured MCP servers are trusted.

Claude supports the configured turn count. Codex does not currently enforce a
turn count. Both harnesses share the hard wall-clock limit.

## AG-UI

Set `COMPADRE_TANSTACK_AI_ENABLED=true` to expose authenticated `POST /ag-ui`.
It accepts a standard AG-UI `RunAgentInput` and returns a TanStack AG-UI SSE
response. `forwardedProps.provider` may select `claude-code` or `codex`.

Only allowlisted provider, model, Fable, and max-turn fields affect the harness;
arbitrary forwarded properties cannot replace adapters or tools.

## Verified behavior

- Claude Code and Codex both run through the production Slack Events path.
- Claude streams text deltas. Codex publishes status/tool progress during the
  run and its terminal answer when the run finishes.
- Same-provider native session resume works for both harnesses.
- Provider switches retain the bounded neutral transcript while starting the
  correct provider-native session.
- Both harnesses share system prompts, worktree setup, MCP tools, cancellation,
  and dangerous non-interactive permission policy.
- TanStack OpenTelemetry emits agent, LLM, tool, model, token/cache/reasoning,
  duration, error, and cost attributes to Datadog LLM Observability. Claude
  supplies provider-reported cost; Datadog estimates Codex cost from its model
  and token metadata.
- One-shot worktrees and thread state are released; threaded conversations keep
  their worktree and provider sessions for the life of the process.

## Provider-neutral instructions

TanStack Intent is installed as a development dependency and maintains the
version-matched guidance in `AGENTS.md`. Compadre's domain workflow files are
identified by absolute path in the system prompt. Claude can use its plugin
commands; Codex and other harnesses can read the same `SKILL.md` sources
directly.

## Deliberately deferred durability

Postgres is not part of this milestone. `HarnessThreadStore` currently keeps:

```text
thread ID
  -> shared worktree ID
  -> bounded provider-neutral transcript
  -> Claude Code session ID
  -> Codex session ID
  -> last provider
```

The durability milestone should combine a Postgres-backed thread store,
TanStack persistence stores, a distributed `LockStore`, and durable/shared
provider session plus worktree storage. Postgres alone cannot make native
Claude/Codex session directories or git worktrees portable between hosts.

## Remaining considerations

- Claude streams token deltas; Codex currently emits completed message bursts.
- The local-process sandbox provides lifecycle plumbing, not host isolation.
  Both harnesses intentionally have unrestricted tool permissions.
- Required-versus-optional MCP policy is not yet explicit; unavailable optional
  integrations are logged and skipped.
- Claude Code and Codex are pinned project dependencies so deployments do not
  depend on globally installed CLIs.
