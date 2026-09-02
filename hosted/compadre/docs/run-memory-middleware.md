# withRunMemory: durable harness activity for follow-up turns

## Status

Design implementing the "hybrid activity index plus on-demand retrieval"
direction from
[`harness-tool-history-persistence.md`](harness-tool-history-persistence.md).
Shaped as a self-contained TanStack `ChatMiddleware` so it can be validated in
Compadre first and proposed upstream afterwards.

The observe/persist/project core is implemented in
`src/tanstack/run-memory.ts`, wired into `createHarnessStream`, and verified
database-free by `src/tanstack/run-memory.test.ts` and
`src/tanstack/run-memory.integration.test.ts` (the PR #99 pattern: in-memory
persistence over the same store contracts as the Postgres deployment plus a
scripted harness adapter). The `recall_agent_activity` tool is not implemented
yet; its MCP-bridge spike below is still open.

## What upstream already solves, and what it deliberately does not

Reading `@tanstack/ai@0.44.0`, `@tanstack/ai-persistence@0.1.2`, and
`@tanstack/ai-sandbox@0.3.1` changes the problem statement from the original
note:

1. **Harness tool calls and results are already persisted.** `withSandbox`
   contains an internal `ToolHistoryRecorder`
   (`@tanstack/ai-sandbox/src/tool-history.ts`) that converts passthrough
   `TOOL_CALL_START/ARGS/END/RESULT` chunks into ordinary
   `role: "assistant"` + `toolCalls[]` and `role: "tool"` transcript messages,
   tagged `metadata.sandboxObserved === true`. Because the recorder appends to
   `ctx.messages` during the stream, `withPersistence.onFinish` saves them into
   the canonical message store. Compadre already runs both middlewares, so
   `compadre_ai_threads` already contains full tool history for new turns.
2. **They are deliberately excluded from future model requests.**
   `withSandbox.onConfig` runs `stripObservedToolCalls` on every turn: observed
   calls name tools the provider was never given, and one triage-sized run is
   hundreds of kilobytes of tool output. Upstream treats these messages as
   *display* history (reload/rejoin rendering), not model context. That is
   exactly the gap our note describes, confirmed as intentional upstream
   behavior rather than an accident.
3. **Reasoning is captured nowhere.** Both harness adapters emit the modern
   `REASONING_*` chunk family (Claude streams deltas; Codex emits one burst per
   item). The chat engine explicitly no-ops on them, `withPersistence` ignores
   them, and the tool-history recorder does not observe them. Reasoning exists
   only in the delivery log (`compadre_ai_stream_events`).
4. **The persisted tool messages are missing operational detail.** No
   timestamps or durations, no `state: "output-error"` flag, no native session
   id, no distinction between a real result and the synthesized
   `{"status":"interrupted"}`, and raw uncapped result content.
5. **Adapter facts that constrain the design** (verified in dist sources):
   - Claude Code emits `TOOL_CALL_START/ARGS/END` synchronously per call;
     `TOOL_CALL_END.input` carries the final parsed args. Codex is two-phase
     (`item.started` opens, `item.completed` resolves), so real durations exist
     only there.
   - Every `TOOL_CALL_START` is eventually paired with a `TOOL_CALL_RESULT`;
     interrupted calls get a synthetic `{"status":"interrupted"}` result.
   - Failures arrive as `TOOL_CALL_RESULT.state === "output-error"`.
   - Codex tool names are item types (`command_execution`, `file_change`,
     `web_search`, `todo_list`, `mcp_tool_call`), not native names like `Bash`.
   - Native session ids arrive as `CUSTOM` chunks named
     `claude-code.session-id` / `codex.session-id` (both packages export
     `SESSION_ID_EVENT`). The Claude payload also includes `model` and the
     enabled `tools` list.
   - Sub-agent (Task) internals never cross the adapter boundary — the Claude
     adapter drops every message with `parent_tool_use_id`. No middleware can
     recover them; only the outer `Task` call and its final result are visible.

So the missing piece is not storage. It is a provider-neutral, bounded,
sanitized **projection of prior activity into fresh-session model context**,
plus **on-demand recall** of exact detail.

## Design overview

One new middleware, following the `withX(backend)` convention:

```ts
import { withRunMemory } from "@tanstack/ai-run-memory"; // or ai-sandbox/ai-persistence, see "Upstream path"

chat({
  middleware: [
    withPersistence(persistence),
    withRunMemory(runMemory, options),
    withLocks(locks),
    withSandbox(sandbox),
  ],
});
```

`withRunMemory` does three things:

1. **Observe** — during each run, deterministically derive a compact
   `RunMemoryRecord` from the chunks it sees (`TOOL_CALL_*`, `REASONING_*`,
   `*.session-id`, terminal events). Observation only; it never transforms or
   drops chunks.
2. **Persist** — at each terminal hook, upsert the record (keyed by run id)
   into a small pluggable `RunMemoryStore`, pruned by count and size.
3. **Project** — at `onConfig` (init phase), when the turn is *not* resuming a
   native provider session, append a bounded textual digest of recent records
   to `config.systemPrompts`, and optionally register a `recall_agent_activity`
   tool for exact or older detail.

The full AG-UI run log stays the audit source of truth; records carry
`runId` so recall can always reach the raw events.

```text
turn N (any provider)
  chunks ──▶ withRunMemory.onChunk ──▶ RunMemoryRecord ──▶ RunMemoryStore
                                                              │
turn N+1, fresh host / lost session / provider switch         ▼
  onConfig ──▶ load records ──▶ digest ──▶ systemPrompts patch + recall tool
turn N+1, same native session
  onConfig ──▶ modelOptions.sessionId present ──▶ inject nothing
```

## The store contract

Mirrors `MessageStore`'s full-replace shape, with the same `defineX` typer,
in-memory reference implementation, and conformance-test expectations the
persistence package sets (`types.ts` evolution policy: methods required, never
optional-and-feature-detected):

```ts
export interface RunMemoryStore {
  load: (threadId: string) => Promise<Array<RunMemoryRecord>>; // [] never null, oldest first
  save: (threadId: string, records: Array<RunMemoryRecord>) => Promise<void>; // full replace
}

export function defineRunMemoryStore(store: RunMemoryStore): RunMemoryStore;
export class InMemoryRunMemoryStore implements RunMemoryStore { … }

/** Adapter over the existing MetadataStore: namespace "run-memory", key = threadId. */
export function metadataRunMemoryStore(metadata: MetadataStore): RunMemoryStore;
```

The metadata adapter means **Compadre needs no schema change**:
`compadre_ai_metadata` already exists and is already wired through
`createPostgresChatPersistence`. A dedicated Drizzle table stays open as a
later optimization if per-run querying outgrows one JSON value per thread.

Upsert-by-`runId` plus full-replace save makes persistence idempotent under
run recovery and journal replay, which re-emit the same chunks with the same
tool-call ids.

The full-replace contract assumes **one writer per thread at a time**. Compadre
guarantees this: thread turns are serialized by `ThreadRunCoordinator` /
Postgres advisory locks before a run starts, so two terminal saves for one
`threadId` cannot race. A host without that guarantee needs its own
serialization or an atomic update; that stays the host's responsibility rather
than a CAS requirement baked into the minimal store contract.

## The record

Deterministically extracted — never model-written — per design requirement 3
of the original note. Epoch-ms timestamps per store convention.

```ts
export interface RunMemoryRecord {
  version: 1;
  runId: string;
  provider: string;            // ctx.provider
  model?: string;
  sessionId?: string;          // from CUSTOM *.session-id
  startedAt: number;
  finishedAt?: number;
  status: "completed" | "failed" | "aborted";
  reasoning?: string;          // capped; head of concatenated REASONING content
  tools: Array<ToolMemoryEntry>;
  truncated: boolean;          // any cap applied anywhere in this record
}

export interface ToolMemoryEntry {
  toolCallId: string;
  name: string;                // normalized (see below)
  rawName?: string;            // provider-native name when it differs
  args: string;                // sanitized, capped JSON projection
  outcome: "ok" | "error" | "interrupted";
  resultPreview: string;       // sanitized, capped
  startedAt?: number;
  durationMs?: number;         // Codex two-phase calls only
}
```

Extraction rules, per verified adapter behavior:

- Args come from `TOOL_CALL_END.input` when present (final parsed object),
  falling back to accumulated `TOOL_CALL_ARGS.args ?? deltas` — the same
  precedence the upstream recorder uses.
- `outcome` is `"error"` when `TOOL_CALL_RESULT.state === "output-error"`,
  `"interrupted"` when the content is the synthesized
  `{"status":"interrupted"}`, else `"ok"`.
- Codex names are normalized through a built-in map
  (`command_execution → shell`, `file_change → edit`, …) with the raw name
  preserved; an option overrides it. `mcp__<server>__<tool>` names pass
  through unchanged.
- Reasoning accumulates `REASONING_MESSAGE_CONTENT` deltas across the run and
  keeps a capped head (plans live at the front; the terminal answer already
  survives in the transcript).

### Bounds and redaction

All defaults overridable via `WithRunMemoryOptions`:

| Bound | Default |
|---|---|
| records kept per thread | 20 runs |
| tool entries per run | 40 (keep first and last, mark `truncated`) |
| `args` chars per entry | 256 |
| `resultPreview` chars per entry | 400 |
| `reasoning` chars per run | 1,500 |
| digest chars injected per request | 6,000 |

Redaction happens **before** anything is stored, not at projection time, so a
leaked value never sits in the store:

1. Built-in key-based scrub on parsed args/result JSON: values under keys
   matching `/(authorization|token|secret|password|api[-_]?key|cookie|credential)/i`
   become `"[redacted]"`.
2. A caller-supplied `redact?: (entry: ToolMemoryEntry) => ToolMemoryEntry`
   for domain rules (e.g. Compadre scrubbing Slack user tokens or Render env
   dumps).

## Middleware hooks

Authored with `defineChatMiddleware`, per-run state in a module-level
`WeakMap<object, RunMemoryRunState>` keyed by `ctx` (the upstream convention —
factory results can be reused across runs). Every side effect is wrapped so a
memory failure can never fail the run: this middleware is auxiliary by
definition.

```ts
export function withRunMemory(
  store: RunMemoryStore,
  options: WithRunMemoryOptions = {},
): ChatMiddleware {
  return defineChatMiddleware({
    name: "run-memory",

    setup(ctx) { runState.set(ctx, createRunState(ctx, options)); },

    async onConfig(ctx, config) {
      if (ctx.phase !== "init") return;
      const records = await safeLoad(store, ctx.threadId);
      runState.get(ctx)!.priorRecords = records;
      const patch: Partial<ChatMiddlewareConfig> = {};
      if (records.length && shouldInject(ctx, options)) {
        patch.systemPrompts = [...config.systemPrompts, digest(records, options)];
      }
      // Deliberately not gated on shouldInject: the tool is a capability,
      // not injected context, and older-than-session detail is useful even
      // when a resumed native session skips the digest.
      if (options.recallTool !== false && records.length) {
        patch.tools = [...config.tools, recallTool(store, ctx.threadId, options)];
      }
      return patch;
    },

    onChunk(ctx, chunk) { runState.get(ctx)?.observe(chunk); }, // observe-only, returns void

    async onFinish(ctx) { await persistRecord(ctx, store, "completed"); },
    async onError(ctx)  { await persistRecord(ctx, store, "failed"); },
    async onAbort(ctx)  { await persistRecord(ctx, store, "aborted"); },
  });
}
```

Notes against the runner's composition semantics:

- `onConfig` is piped in array order; this middleware only appends to
  `systemPrompts`/`tools` and never touches `messages`, so it composes with
  the sandbox strip and the persistence merge regardless of its position in
  the array. The only real constraint is being present at all.
- `onChunk` returns `void` (pass-through) — it can never corrupt the stream.
- Failed and aborted runs still persist a record: "you tried X and it errored"
  is precisely the memory a follow-up question needs.
- `persistRecord` is `try/catch`-guarded and logged; `onFinish` throws are
  reported by the runner, and this middleware must never be the thing that
  turns a successful agent run into a failure.

### When to inject

Default `shouldInject`: skip when `ctx.modelOptions?.sessionId` is set. A
resumed native session already contains its own richer history (design
requirement 7: native resume stays the fast path, not the source of truth), so
the digest is only spent on fresh sessions, fresh hosts, and provider
switches. Overridable via `shouldInject?: (ctx) => boolean` for hosts with
their own resume signal.

### Digest format

Deterministic text, newest runs last, one fenced block appended as its own
system prompt so `systemPromptMode: "replace"` harnesses receive it verbatim:

```text
## Prior agent activity (durable memory; may be truncated)
Earlier turns in this thread performed the actions below. Exact arguments and
results are retrievable with the recall_agent_activity tool.

[run run-122 · claude-code · 2026-08-11T22:14Z · completed]
reasoning: Verified the Render deploy for PR #97 was live before answering…
- render.get_deploy {"deployId":"deploy-123"} → ok: {"status":"live","commit":"566ff79"…}
- shell {"command":"git log --oneline -5"} → ok

[run run-123 · codex · 2026-08-12T09:03Z · failed]
- edit {"changes":[{"path":"src/app.ts","kind":"update"}]} → error: TypeError …
```

If the block would exceed the digest budget, whole oldest runs are dropped
first. If the newest run alone still exceeds the budget (many large entries),
its trailing lines are cut behind an explicit `(digest truncated)` marker —
entries are removed whole, never split mid-line, so a result is never
misattributed to the wrong call.

### The recall tool

An ordinary engine tool, so it reaches the harness through the existing
TanStack MCP bridge and produces valid tool-call/result model messages
(design requirement 6 — no synthesized malformed messages):

```ts
recall_agent_activity({
  runId?: string,      // exact run
  toolName?: string,   // filter by normalized name
  contains?: string,   // substring over args/result previews
  limit?: number,      // default 5
})
```

Level 1 (always available): answers from `RunMemoryRecord`s — bounded and
already redacted. Level 2 (optional): a
`detail?: (threadId, runId, toolCallId) => Promise<string | null>` option lets
the host resolve full raw detail; Compadre's implementation reads
`compadre_ai_stream_events`, keeping the run log the single audit source.
Level-2 output passes through the same caps and redaction before returning to
the model.

## Compadre integration

1. **Wiring** (`src/tanstack/harness.ts`): insert
   `withRunMemory(metadataRunMemoryStore(persistence.stores.metadata), {...})`
   into the middleware array when persistence is configured. No new tables.
2. **Fresh-session detection**: the generic `modelOptions.sessionId` default
   works — `createHarnessStream` sets `sessionId` in `modelOptions` for both
   providers exactly when `resumableHarnessSession` found one.
3. **Level-2 recall**: implement `detail` over the existing durable run-event
   query path in `src/durability/`.
4. **Transcript retention** (separate, recommended): the sandbox recorder's
   raw tool results accumulate uncapped inside `compadre_ai_threads`. With the
   digest plus run-log recall in place, Compadre can wrap its `MessageStore`
   to cap or age out `sandboxObserved` messages using the public
   `isSandboxToolCall` helper — exactly the pruning upstream documents as the
   app's decision.
5. **Channel-wrapper compatibility**: PR #98 made
   `createChannelConversationPersistence` locate the turn boundary by a
   synthetic message ID instead of prefix length, precisely because the
   sandbox strip shortens histories between load and save — and it now throws
   if a middleware removes that boundary message. `withRunMemory` never
   touches `config.messages`, so it cannot disturb the boundary; any future
   change to that invariant must keep the boundary-tagged message intact.
6. **Known fragility to leave alone but track**: Compadre's middleware order
   (`persistence` before `sandbox`) means `withPersistence.onFinish` saves the
   transcript before `withSandbox.onFinish` runs its final tool-history
   reconcile. It works today only because harness runs are single-iteration
   and the recorder appends live during the stream. Worth an upstream issue;
   not something this middleware depends on.

## Validation

The vertical flows from the original note apply directly:

1. Turn 1 makes a recognizable harness tool call; turn 2 on the same native
   session answers about it (native path, digest not injected).
2. Delete the process-local session; a fresh session identifies tool, safe
   target, and outcome purely from the digest.
3. Switch providers (`--sol` after a Claude turn); same grounded answer.
4. Ask for exact arguments; the agent uses `recall_agent_activity` instead of
   receiving raw history in the prompt.
5. Seed a run with an `Authorization` header in tool args; assert it is
   `[redacted]` in the store, the digest, and recall output.
6. Kill and reclaim a run mid-stream; assert replay produces one record, not
   duplicates (upsert by `runId`).
7. A 30-turn thread keeps the digest under budget and prunes oldest records.

Spike items to confirm before implementation:

- Middleware-injected tools (`onConfig` patch) actually reach the Claude
  Code/Codex processes through Compadre's MCP-client setup; fallback is
  registering the recall tool explicitly in `harness.ts`.
- Digest size in practice on real Slack threads (tune default bounds).
- Whether Codex's synthesized unresolved results match the interrupted-shape
  detection exactly.

## Key decisions and findings from the implementation review

Recorded from the design/implementation discussion (2026-08-13) so the
reasoning survives the conversation:

1. **The gap is model context, not storage.** Upstream already persists
   harness tool calls (`withSandbox`'s recorder + `withPersistence`) but
   deliberately strips them from every model request as display-only history,
   and reasoning is captured nowhere. Any fix that "persists tool calls" is
   re-solving a solved problem; the missing piece is projection.
2. **The digest lives in `systemPrompts`, not `messages` — deliberately.**
   `messages` is a persisted, contested surface: persistence saves it back
   verbatim (an injected message would become permanent canonical history),
   and three middlewares already rewrite it (persistence merges, sandbox
   strips, the channel wrapper slices by turn boundary). `systemPrompts` is
   append-only and untouched by others, which is what makes `withRunMemory`
   position-independent. There is also no honest `ModelMessage` role for
   injected context (`user`/`assistant`/`tool` would each fabricate
   something), and harness adapters flatten messages into the spawned
   process's prompt anyway. Revisit trigger: models observably
   under-attending to the digest — the fix then is an upstream ephemeral
   message concept (`persist: false` or a `context` role), not local
   strip-and-reconcile machinery.
3. **Kill switch, in code by request:** `RUN_MEMORY_MODE` in
   `src/tanstack/run-memory.ts` — `on` (default) | `observe` (record but never
   inject; keeps history while diagnosing suspected harm) | `off`. A
   code-level constant rather than an environment variable so flipping it is
   a reviewed, versioned change with identical behavior in every environment.
4. **Native session resume requires consecutive same-provider turns**
   (`resumableHarnessSession` checks `lastProvider`), so every provider
   alternation is a fresh session. The digest path is exercised far more
   often than "rare recovery" intuition suggests.
5. **Live-verification evidence bar:** the provider-switch turn answered
   with Claude's private `description` tool argument and `<`-redirection —
   content that exists only in the durable record, not in the transcript and
   not reproducible by re-running the command. Prefer evidence a model could
   not fake or re-derive.
6. **Found and fixed while verifying:** the memory durability backend could
   never deliver a real harness run — `captureDurableRun`'s from-start reader
   hit `memoryStream`'s 100ms unknown-run fail-fast while Claude/Codex spawn
   for seconds. Producers now pass a 60s `firstChunkDeadlineMs`; joiners keep
   fail-fast. Trap for the future: `memoryStream(init, options)` takes the
   deadline in the second argument; inside the first it is silently ignored.
7. **Redaction is key-based.** A secret embedded in a plain string argument
   (e.g., inline in a shell command) survives scrubbing — treat digest
   content with the same sensitivity as the transcript it derives from.

## Upstream path

- The middleware is fully self-contained: no imports from `ai-sandbox`, one
  type import (`MetadataStore`) from `ai-persistence` for the optional
  adapter. Three plausible homes, in preference order:
  1. `@tanstack/ai-sandbox` — it already owns the other half of this problem
     (the recorder, `sandboxObserved`, the strip), and the doc comment in
     `tool-history.ts` is this proposal's problem statement verbatim;
  2. a small `@tanstack/ai-run-memory` package;
  3. `@tanstack/ai-persistence` as a second middleware beside
     `withPersistence`.
- Contribution should follow their observed conventions: `withX` factory via
  `defineChatMiddleware`, `defineRunMemoryStore` typer, `InMemoryRunMemoryStore`
  reference, conformance testkit, epoch-ms timestamps, a `skills/` SKILL.md
  entry, `Array<T>` style, and rationale comments on non-obvious choices.
- Two adjacent upstream asks worth filing regardless: the
  persistence-before-sandbox `onFinish` ordering fragility, and (long-term)
  surfacing sub-agent activity across the Claude adapter boundary, which no
  middleware can recover today.

## What this does not solve

- Sub-agent (Task) internals — invisible at the adapter boundary by design.
- Cross-thread memory — records are strictly thread-scoped.
- Workspace state — a fresh host still cannot see uncommitted files; the
  existing "commit to a branch or PR" rule stands.
