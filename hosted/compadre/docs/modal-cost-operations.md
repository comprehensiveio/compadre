# Modal cost operations

Compadre uses standard Modal Sandboxes. The current code does not enable
Modal's experimental VM Sandbox runtime. The guest still looks like an Ubuntu
container, while Modal supplies the isolation, scheduling, encrypted tunnels,
remote execution, resource accounting, and lifecycle control plane.

## Current cost controls

- CPU and memory requests default to 0.5 core and 2 GiB (production requests
  2 cores and 16 GiB). Modal charges the greater of requested and actual
  usage, so these requests define the idle floor; configured burst limits are
  not automatically billed at their maximum.
- A worker sandbox lives for its whole configured lifetime (24 hours by
  default) whether or not a turn is active — reliability is prioritized over
  idle compute cost. At Modal's published August 2026 rates, the production
  request is roughly $0.98 per worker-hour before network, snapshot storage,
  or usage above the request.
- After every terminal turn the worker's filesystem is checkpointed live (no
  quiesce, no termination). Checkpoint images expire after seven days by
  default.

Pricing changes; verify current rates in Modal's pricing and Sandbox resource
documentation before using these estimates for a budget.

## Attribution and alerts

Every newly created or restored sandbox is tagged with `managedBy`,
`environment`, `purpose`, `provider`, `devEnvironment`, `workerGeneration`, and
a truncated SHA-256 hash as `threadKey`. It does not embed the raw Slack or
thread identifier, but it remains linkable by anyone holding a candidate value;
use a secret salt if operational requirements demand unlinkability. Do not put
raw Slack or thread identifiers into Modal tags.

Datadog receives a lifecycle transition counter. Useful initial monitors are:

- any live duration approaching `COMPADRE_MODAL_TIMEOUT_MS`;
- repeated `checkpoint.failed` or `restore.failed` transitions;
- active sandbox count and worker-hours grouped by environment, provider, and
  dev-environment tag;
- checkpoint restore failures before the seven-day retention boundary.

If sandbox worker-hours become a cost problem, add a boring garbage-collection
pass for long-idle workers — do not reintroduce per-run lifecycle management.
Avoid increasing CPU or memory requests to address rare bursts: first inspect
actual usage, then change the request only when the sustained workload needs it.

Sources: [Modal pricing](https://modal.com/pricing), [Sandbox resource and
billing behavior](https://modal.com/docs/guide/sandbox-resources), and
[filesystem snapshots](https://modal.com/docs/guide/sandbox-snapshots).

Run the predeployment gates in
[`modal-lifecycle-testing.md`](./modal-lifecycle-testing.md) before changing
timeout, snapshot, or resource settings.
