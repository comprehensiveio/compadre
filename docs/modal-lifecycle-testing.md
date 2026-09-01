# Modal worker lifecycle testing

The worker lifecycle is deliberately simple: one sandbox lives for the whole
task (24-hour Modal lifetime by default), a live filesystem checkpoint is
captured after every terminal turn without stopping the worker, and a dead
sandbox is restored from its last checkpoint on the next turn. There is no
warm lease, no hibernation, and no sweeper.

## Gate 1: deterministic local lifecycle

```bash
npx tsx --test --test-name-pattern \
  "checkpoints a terminal turn" \
  src/t3/gateway.test.ts
```

This vertical test uses the real binding store and gateway state machine with
in-memory persistence. It proves:

- the terminal turn records a checkpoint while the worker keeps running;
- a new controller instance reconnects to the still-live sandbox instead of
  provisioning another logical thread;
- after the sandbox dies, the next turn restores from the checkpoint;
- sandbox ID and worker generation change while the native T3 thread ID stays
  fixed; and
- the next command uses `startTurn`, not `startNewThread`.

Related focused tests cover Modal tag privacy, live checkpoint capture without
quiesce or termination, restore failure state, and the five-minute watch
safety margin before the sandbox's hard timeout. Run all of them with:

```bash
npx tsx --test \
  src/services/t3-thread-bindings.test.ts \
  src/tanstack/modal-sandbox.test.ts \
  src/t3/modal-environments.test.ts \
  src/t3/modal-worker.test.ts \
  src/t3/gateway.test.ts
```

## Gate 2: end-to-end Temporal probe

```bash
npm run temporal:up
npm run temporal:probe
```

The probe drives the full durable run path (workflow launch, mid-watch crash
retry, resume without duplication, durable cancellation) against a real local
Temporal server with a fake Modal gateway.

## Gate 3: deployment canary

Only Modal's control plane can prove image capture/restore and encrypted
tunnel behavior. Only the deployed Render/T3 pair can additionally prove
Postgres metadata, service authentication, preview proxying, Slack delivery,
and a controller deploy mid-task. After gates 1 and 2 pass, use one
non-production Slack thread (`#slack-bot-test`) for that final canary.

No local test can prove recovery if the worker is forcibly deleted before its
first successful checkpoint. An active provider turn also cannot survive past
`COMPADRE_MODAL_TIMEOUT_MS` (24 h default); the checkpoint protects the
thread's continuity across worker death, not arbitrarily long single turns.
