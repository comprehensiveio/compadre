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

`terminal.open` has an optional `startWorker` flag. Only the Start workspace button
sets it. Attach, input, resize, clear, restart, close, retries, metadata
subscriptions and browser reloads cannot set startup intent. The controller's
operation-specific schema drops extraneous flags, so forwarding one on attach
cannot wake a worker. Opening the panel automatically attaches to an existing
worker; the UI exposes only Start workspace when attachment is unavailable.

Saved conversations and diffs do not use either worker acquisition operation.

## Transport and ownership

Central T3 authenticates terminal connection requests through the existing terminal
RPC scope and validates the canonical thread. The controller uses `attachWorker`
to resolve the worker and its trusted directory. Supported workers issue a
30-second, single-use grant bound to that native thread, terminal, directory and
size. The browser receives the worker WebSocket URL and this grant; controller
and worker service credentials stay on the servers. Grants live only in memory,
are not persisted in thread state, and become invalid when the worker process
restarts. The direct socket is limited to one hour and then reconnects through
the ordinary attach path.

Interactive input, resize and output use `/terminal/direct` on the worker via
its Modal tunnel. The first WebSocket frame consumes the ticket. Subsequent
frames cannot select another terminal, change the working directory, provision
a worker, or call arbitrary RPCs. Output acknowledgments bound unconsumed data
to 2 MiB; input queues and message sizes are bounded. Input is pipelined in order
without waiting for each earlier acknowledgment. Socket failure rejects pending
input without replaying it.

The shared client-runtime terminal adapter selects direct transport when the
central server advertises `directTerminals`. A failed connection, expired ticket,
or older worker falls back to the existing authenticated relay and takes a fresh
terminal snapshot. Fallback can only attach; it never supplies startup intent.
Direct process-status events feed the client metadata projection, including the
running-subprocess close warning. Web and desktop share this path; mobile uses
the shared transport with its native WebSocket implementation.

Open/start, clear, restart and explicit close still use the central controller
path, preserving lifecycle serialization and checkpoint ownership. The relay
continues to multiplex worker T3 JSON RPC, with HTTP NDJSON output and persistent
WebSocket input. Older clients and workers remain compatible during rollout.
New/restored workers start with `COMPADRE_DIRECT_TERMINAL_WORKER=1`; their pinned
T3 package must include the direct endpoint. Already-running older workers keep
the relay until they are naturally replaced, without a forced restart.

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

Web and desktop share automatic attachment and the Start workspace UI, including terminal panel,
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
