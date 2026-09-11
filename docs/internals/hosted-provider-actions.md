# Hosted provider actions

Provider actions operate the harness; they are not instructions to the model.
`compact` is the first supported action. A slash-command suggestion alone does
not establish action support: many slash commands are skills or ordinary prompts.

## Execution contract

`packages/contracts/src/providerActions.ts` defines the allowlist, native command,
and provider support. `thread.turn.start` carries an optional `providerAction`,
which survives the requested event, reactor, adapter, controller's durable run
request, gateway, and worker dispatch. Exact `/compact` input is classified at
command admission for existing buttons, typed commands, and older clients.
Only the provider adapter translates an action into native harness input.

Actions reuse turn command IDs, cancellation, native event delivery, and terminal
receipts. They do not accept attachments or steering. Compaction sends exactly
`/compact` to Claude's SDK without effort prefixes. A successful SDK result alone
is insufficient: the adapter must observe `system/compact_boundary` during the
action or mark the turn failed. Ordinary conversational turns are unchanged.

Hosted transport uses `POST /hosted/t3/actions`; replay uses the existing
`GET /hosted/t3/runs/:runId/events`. The controller deliberately skips requester
prompt decoration, artifact instructions/collection, and Slack mirroring for
actions. The canonical user message still retains its original attribution.
The controller recognizes exact `/compact` on the legacy chat endpoint too.

Workers expose authenticated `GET /api/compadre/provider-actions` capability
discovery and `POST` dispatch, requiring `orchestration:operate`. Separate action
endpoints ensure older controllers/workers return an error instead of silently
dropping the action field and running a prompt. There is no chat fallback.
An idle older worker is checkpointed and restored through the existing upgrade
path; the replacement must pass capability validation before replacing the old
binding. Compaction never provisions a fresh conversation to replace lost context.

## Capability discovery and clients

`ServerProvider.providerActions` contains supported action IDs. Missing means no
support. Hosted discovery obtains these IDs from the controller's model-discovery
response, then intersects them with the central adapter's implementation. This
does not wake workers; worker support is checked when executing an action.

Web/desktop's resume banner and context-meter action use this capability, not
merely the Claude provider name. Mobile and other callers share the typed-command
admission path; no mobile-only button is added. Settings' automatic compaction is
a separate Claude configuration feature. Codex, Cursor, Grok, and OpenCode do not
advertise this action until their adapters implement its native completion contract.

### Native timeline presentation

Web/desktop reuse upstream T3's compaction separator and progress presentation
from `c5ba51d62` (#9293) in the existing `MessagesTimeline` components. The exact
attachment-free command remains in central storage for attribution, replay, and
turn boundaries, but is rendered as a system action rather than a chat bubble.
The resume banner, context meter, and typed `/compact` therefore converge on the
same presentation. Do not add a hosted-only compaction widget or infer success
from assistant prose.

Optimistic and persisted requests show `Compacting…` instead of `Thinking` while
active. A native `context-compaction` activity replaces the request marker with
the normal system separator and stays outside folded tool groups. Cancellation
and unconfirmed requests remain distinguishable from successful compaction.
Cancellation also follows native `provider.turn.completed` receipts with
`state: interrupted`: checkpoint completion can mark the turn row completed,
but must not erase the cancellation label on reload or a later turn.
The presentation follows persisted events on reload and remote connections;
it does not change the wire schema, provider execution, or mobile rendering.

## Adding an action or merging upstream actions

1. Add a discriminated action schema, arguments, native mapping, and supported
   providers to the contracts catalog and the controller's npm-owned Zod wire
   counterpart (`hosted/compadre/src/t3/provider-actions.ts`). Unknown types must
   fail validation. Update the shared `packages/contracts/fixtures/provider-actions.json`
   compatibility cases exercised by both toolchains. Do not create an arbitrary
   slash-command passthrough.
2. Implement native execution and an explicit success/failure receipt in each
   supported adapter. Decide attachment, busy-state, cancellation, and recovery
   semantics; do not infer success from an assistant's words.
3. Advertise only implemented actions in local snapshots, controller discovery,
   and the worker capability endpoint. Keep all three in agreement.
4. Pass the typed action through the existing durable path. If upstream introduces
   a dedicated operation lifecycle, map it at this boundary instead of wrapping
   it in a user prompt or introducing another conversation store.
5. Test prompt isolation, unsupported/mixed versions, durable replay, native
   completion, and capability-gated entry points. Check web/desktop, mobile,
   command-palette/keybinding entry points, and all provider adapters.

Roll out the worker image/fork and controller before central web. Mixed versions
fail closed. A restored worker must use the new fork; a controller update alone
cannot add action support to an old image. Verify a real idle, high-context Claude
thread after deployment: one action, a native compaction activity, reduced context,
no assistant refusal, and no Slack mirror or artifact delivery.
