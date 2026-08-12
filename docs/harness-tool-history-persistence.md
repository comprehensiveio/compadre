# Harness tool history across persisted turns

## Status

Follow-up design note for the initial `@tanstack/ai-persistence` deployment.
The first persistence change makes the provider-neutral conversation transcript
durable in Postgres. This note describes a remaining gap: preserving enough
Claude Code and Codex tool activity for a later turn to answer questions about
what the agent previously did, even when its native provider session is gone.

## The problem

TanStack AI has two relevant persistence layers with different contracts:

- `@tanstack/ai-persistence` saves conversation state, principally the
  authoritative `ModelMessage[]` transcript used to construct a later model
  request.
- Compadre's run durability saves the AG-UI event stream used for delivery,
  replay, auditing, and run recovery.

Tools executed by TanStack's own agent loop can become assistant tool-call and
tool-result model messages. Those messages naturally survive in the canonical
transcript. Claude Code and Codex are different: each is an autonomous harness
with native tools such as shell, file editing, and MCP. Much of that activity is
reported to the outer TanStack runtime as AG-UI or custom stream events rather
than as canonical model messages.

That creates this behavior:

```text
same native harness session
  -> provider session transcript remembers rich tool activity

fresh host, lost native session, or provider switch
  -> Postgres restores the user/assistant conversation
  -> raw tool activity remains in the durable run log
  -> raw tool activity is not automatically included in model context
```

For example, a first turn may query Render and correctly answer that deployment
`deploy-123` is live. A later fresh Codex or Claude session can see that answer,
but it may not be able to say precisely which Render tool was called, what
arguments were supplied, or which intermediate result led to the answer.

This is not a database-adapter deficiency and is not a general inability of
`@tanstack/ai-persistence` to store tool messages. It is an adapter-boundary and
context-design issue: harness-native activity exists in a different durable
representation from the transcript automatically loaded into the next turn.

## Current Compadre data flow

```text
Claude Code / Codex harness
  |-- assistant conversation output
  |     -> ModelMessage transcript
  |     -> compadre_ai_threads
  |     -> loaded for future turns
  |
  `-- tool/progress/custom events
        -> AG-UI StreamChunk log
        -> compadre_ai_stream_events
        -> replayable, but not automatically loaded for future turns
```

Relevant implementation seams are:

- `src/tanstack/harness.ts`: composes persistence, locks, and sandbox middleware.
- `src/tanstack/runtime.ts`: resumes native provider sessions when available and
  falls back to the canonical transcript.
- `src/persistence/conversation.ts`: keeps channel-enriched Slack context out of
  canonical history.
- `src/durability/runtime.ts`: records and replays the detailed run event log.
- `src/db/schema.ts`: owns both transcript and run-event storage.

## Design requirements

The follow-up should:

1. Let a fresh process answer factual questions about important prior tool
   activity without requiring the original native session.
2. Keep the full event log as the audit source of truth.
3. Avoid adding every raw tool argument, output, progress event, or file read to
   every subsequent model request.
4. Bound context growth by count and size and remain compatible with later
   transcript compaction.
5. Redact secrets and avoid copying credential-bearing headers, environment
   values, or unbounded database/file contents into reusable model context.
6. Preserve tool-call/result pairing when real tool messages are stored. Do not
   synthesize malformed tool messages merely to make them visible to a model.
7. Work after a provider switch; provider-native session state remains an
   optimization rather than the source of truth.

## Possible approaches

### 1. Persist and move native provider sessions

Store the Claude Code/Codex session directory in durable storage and restore it
on another host before resuming.

Advantages:

- Highest fidelity to the native agent experience.
- Preserves details beyond tool activity, including provider-specific state.

Problems:

- Provider-specific formats and lifecycle behavior become part of Compadre's
  durability contract.
- Session files may contain sensitive or machine-local data.
- It does not help when switching from Claude Code to Codex or vice versa.
- It must coordinate with durable workspaces; restoring only the conversation
  while losing referenced files can be misleading.

This may be valuable later, but it should not be the only canonical solution.

### 2. Convert every harness event into canonical model messages

Translate tool-related stream events into assistant tool-call and tool-result
messages and append them to `compadre_ai_threads`.

Advantages:

- A fresh model receives tool history through the normal transcript path.
- No additional retrieval step is needed.

Problems:

- Raw tool output can be extremely large, noisy, sensitive, or obsolete.
- Provider tool schemas and event sequences may not map cleanly to valid
  TanStack tool-call/result message pairs.
- Replaying implementation detail on every future turn wastes context and can
  distract the model.

This is appropriate only for tool activity that already crosses the boundary
as valid TanStack model messages.

### 3. Store a bounded per-turn activity record

Derive a sanitized record from the event stream at the end of each turn:

```json
{
  "threadId": "slack:C123:1723456789.123",
  "runId": "run-123",
  "turn": 4,
  "summary": "Inspected the Render deployment and confirmed it was live.",
  "tools": [
    {
      "name": "render.get_deploy",
      "target": "deploy-123",
      "outcome": "status=live"
    }
  ],
  "truncated": false
}
```

The record could live in the TanStack metadata store or a dedicated Drizzle
table. A short textual projection could be included in future model context.

Advantages:

- Provider-neutral and compact.
- Straightforward to bound, redact, inspect, and test.
- Keeps canonical conversation history readable.

Problems:

- Summaries are lossy.
- Model-generated summaries can hallucinate unless grounded in deterministic
  event extraction.
- The schema needs enough identity to reach the raw run when exact detail is
  requested.

Prefer deterministic extraction of tool name, safe argument fields, outcome,
and run ID. An optional model-written narrative can be derived from that record,
but should not replace it.

### 4. Retrieve prior run events on demand

Give the agent a TanStack-managed history tool that queries durable run events
by thread, run, tool name, or turn. The canonical transcript or metadata keeps
the run IDs needed for discovery.

Advantages:

- Exact details are loaded only when relevant.
- The raw event log remains the single audit source of truth.
- Large historical results do not consume every future context window.

Problems:

- The model must know when to call the history tool.
- A vague question such as “did you check that earlier?” needs a useful index,
  not a blind scan of every raw event.
- Retrieved results still need size limits and redaction.

### 5. Hybrid activity index plus on-demand retrieval

This is the leading pattern to investigate:

1. Continue storing the canonical conversation with
   `@tanstack/ai-persistence`.
2. Continue storing complete delivery/audit events in the existing run log.
3. At each terminal turn, deterministically derive a small, sanitized activity
   record keyed by thread ID, run ID, and turn.
4. Include a bounded recent activity projection in fresh-session context.
5. Expose a TanStack-managed history tool for exact or older details from the
   raw run log.
6. Keep native Claude/Codex session resume as the fast, high-fidelity path when
   that session is still available.

This provides useful memory after restarts and provider switches without making
the raw event stream part of every prompt.

## Questions to answer in the spike

- Which native Claude Code and Codex activities arrive as normal AG-UI tool
  chunks, which arrive as `CUSTOM` chunks, and which never cross the adapter
  boundary?
- Do host-bridged TanStack/MCP tools already produce valid model messages, or do
  they also require event projection?
- Can activity records be produced deterministically from existing chunks, or
  is adapter-specific normalization required?
- Should recent activity be injected as a system/context message, represented
  as structured metadata, or retrieved exclusively through a tool?
- What are the retention, truncation, and redaction rules for arguments and
  results?
- How should activity summaries interact with the planned rolling transcript
  summary and Slack message checkpoint?
- Is a dedicated activity table easier to query and evolve than namespaced
  values in `compadre_ai_metadata`?

## Suggested validation

An implementation should demonstrate these vertical flows:

1. A first turn makes a recognizable harness-native tool call; a second turn on
   the same native session can identify it.
2. The process-local session is removed; a fresh session can still identify the
   tool, safe target, and outcome from Postgres-backed state.
3. The second turn switches providers and obtains the same grounded answer.
4. A large tool result is truncated or retrieved on demand instead of copied
   into the canonical prompt.
5. Secret-like fields never appear in the activity projection.
6. The activity record links back to the exact durable run events for audit.
7. Repeated persistence or run replay does not duplicate activity records.

The follow-up should begin with an instrumentation spike against both harness
adapters, then choose the smallest normalized activity schema supported by the
events they actually emit.
