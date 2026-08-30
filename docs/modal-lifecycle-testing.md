# Modal worker lifecycle testing

Use three gates before deploying the hosted-T3 worker lifecycle. The first is
fully local and free. The second runs the local controller code against real
Modal APIs, without deploying Render.

## Gate 1: deterministic local lifecycle

```bash
npx tsx --test --test-name-pattern \
  "controller restart, hibernation, and restore" \
  src/t3/gateway.test.ts
```

This vertical test uses the real binding store and gateway state machine with
in-memory persistence. It proves:

- the terminal turn becomes `warm`;
- a new controller instance reconstructs the overdue sweep from durable state;
- hibernation records the snapshot and leaves the binding `suspended`;
- a clock jump to three hours causes restoration, not provisioning of another
  logical thread;
- sandbox ID and worker generation change while the native T3 thread ID stays
  fixed; and
- the next command uses `startTurn`, not `startNewThread`.

Related focused tests cover Modal tag privacy, quiescing the dev stack before
capture, capture-before-termination ordering, restore failure state, and the
five-minute hard-timeout safety margin. Run all of them with:

```bash
npx tsx --test \
  src/services/t3-thread-bindings.test.ts \
  src/tanstack/modal-sandbox.test.ts \
  src/t3/modal-environments.test.ts \
  src/t3/modal-worker.test.ts \
  src/t3/gateway.test.ts
```

## Gate 2: local controller against real Modal

Populate `.env.local` with the same Modal, repository, provider, and optional
dev-environment configuration used by production, then run:

```bash
npm run t3:hibernation-probe
```

The probe performs two small provider turns and one real Modal filesystem
snapshot. Between turns it:

1. writes a random marker into `/workspace`;
2. advances the injected controller clock beyond the 30-minute warm lease;
3. constructs a new gateway instance to simulate a Render restart;
4. runs the overdue-worker sweep;
5. proves the original sandbox cannot reconnect;
6. advances the clock to three hours and sends another message;
7. verifies a different sandbox ID, generation 2, the same native thread ID,
   and the restored filesystem marker; and
8. terminates the restored sandbox in a `finally` block.

The probe leaves only the first filesystem image for post-failure inspection;
its TTL defaults to one hour rather than production's seven days. Override that
with `COMPADRE_T3_PROBE_SNAPSHOT_TTL_MS`. This gate incurs a few minutes of
Modal compute, snapshot storage, and two provider requests.

Do not publish the JSON output in a public issue. It contains sandbox and
thread identifiers, although it contains no credentials or message bodies.

## Gate 3: deployment canary

Only Modal's control plane can prove image capture/restore and encrypted tunnel
behavior. Only the deployed Render/T3 pair can additionally prove Postgres
metadata, service authentication, preview proxying, Slack delivery, and a
controller deploy during the warm interval. After gates 1 and 2 pass, use one
non-production Slack thread for that final canary.

No local test can prove recovery if the worker is forcibly deleted before its
first successful snapshot. It also cannot make an active provider turn survive
past `COMPADRE_MODAL_TIMEOUT_MS`; the hibernation path protects completed idle
workers, not arbitrarily long active runs.
