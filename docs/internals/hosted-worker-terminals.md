# Hosted worker terminals

The hosted terminal uses the same terminal UI and RPC contracts as a local
environment. Central T3 selects `terminal/CompadreTerminal.ts` when
`COMPADRE_NATIVE_T3_URL` is configured. It never falls back to a central shell.

## Worker access and startup intent

The controller gateway owns canonical-thread worker acquisition:

- `attachWorker(threadId)` reads the binding and reconnects to an existing
  worker. It never provisions or restores. Suspended/unavailable workers fail.
- `ensureWorkerRunning(threadId, creation?)` is for deliberate actions. It
  acquires the same per-thread lock used by provider dispatch and preview
  activation, rereads the binding, and uses the shared restore implementation.
  For a new thread, central T3 supplies its stored title/model, and the shared
  provisioning implementation creates a native thread without starting an agent.

Provider dispatch and preview activation use the unlocked helper while already
holding that same lock. Do not acquire the directory-index lock inside the
worker lock. Concurrent starts must reuse the published binding/generation.
Only these gateway lifecycle helpers may introduce a canonical worker generation;
feature adapters must not implement their own restore/provision policy.

`terminal.open` has an optional `startWorker` flag. Only the Start terminal button
sets it. Attach, input, resize, clear, restart, close, retries, metadata
subscriptions and browser reloads cannot set startup intent. The controller's
operation-specific schema drops extraneous flags, so forwarding one on attach
cannot wake a worker. Reconnect retries attachment only.

Saved conversations and diffs do not use either worker acquisition operation.

## Transport and ownership

Central T3 authenticates the client through its existing terminal RPC scopes,
checks that the canonical thread exists, and forwards a bounded NDJSON response
from the authenticated `/hosted/t3/terminal` controller route. The controller
maps the canonical thread to its native thread and derives CWD from the worker's
project/worktree. Central/client CWD and environment values are not forwarded.
Worker credentials never reach the browser.

The controller multiplexes terminal operations over an authenticated worker T3
WebSocket using its existing Effect JSON RPC protocol. Output acknowledgments,
bounded buffers, request cancellation and idle socket cleanup keep the relay
bounded. The central adapter serializes input per terminal to preserve typing
order across HTTP requests. Socket failure never automatically restores a worker.

Disconnecting the browser interrupts only the output subscription. The worker's
terminal manager continues owning the PTY. A later attach gets its retained
history and live output. Explicitly closing a terminal ends its shell. A stopped
worker loses live processes; restoration creates a new shell using the saved
filesystem, not a resumed process.

After explicit shell close, the gateway takes a best-effort filesystem checkpoint
without waking a worker. If an agent run is active, its turn-completion path owns
that checkpoint instead. Closing the panel merely detaches and is not a save or
shell-close operation. Unexpected worker loss can lose edits made since the last
filesystem checkpoint. Saved diff publication still occurs after agent turns;
terminal edits alone do not publish a new diff manifest.

## Clients and verification

Web and desktop share the Start terminal/Reconnect UI, including terminal panel,
drawer, split panes and keyboard entrypoints. Existing mobile terminal clients
can attach to running workers through the same contracts; they do not yet expose
the explicit worker-start button. Local and other remote T3 environments retain
their existing terminal manager. Shell transport is provider-independent; it
does not dispatch Codex, Claude or another provider turn.

Focused tests cover no-wake operations, authentication, unknown central threads,
stream cancellation, fragmented output, input ordering and shared startup
serialization. A local worker T3 server plus controller route can exercise the
real PTY and web UI without creating Modal resources. Production verification
must additionally test Modal tunnels and restoration with both supported native
provider identities before claiming deployed support.
