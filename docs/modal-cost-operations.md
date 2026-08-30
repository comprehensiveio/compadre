# Modal cost operations

Compadre uses standard Modal Sandboxes. The current code does not enable
Modal's experimental VM Sandbox runtime. The guest still looks like an Ubuntu
container, while Modal supplies the isolation, scheduling, encrypted tunnels,
remote execution, resource accounting, and lifecycle control plane.

## Current cost controls

- CPU and memory requests default to 0.5 core and 2 GiB. Modal charges the
  greater of requested and actual usage, so these requests define the idle
  floor; configured burst limits are not automatically billed at their maximum.
- At Modal's published August 2026 rates, that request is approximately $0.119
  per live worker-hour before network, snapshot storage, or usage above the
  request. A full unused 30-minute warm lease is approximately $0.0595.
- A terminal native worker stays warm for 30 minutes, then its stopped
  filesystem is snapshotted and billed compute is terminated.
- The warm deadline cannot extend through the configured two-hour hard sandbox
  timeout: it is capped five minutes before that deadline.
- A one-minute controller sweep catches overdue warm workers after process
  restarts. Snapshot images expire after seven days by default.

Pricing changes; verify current rates in Modal's pricing and Sandbox resource
documentation before using these estimates for a budget.

## Attribution and alerts

Every newly created or restored sandbox is tagged with `managedBy`,
`environment`, `purpose`, `provider`, `devEnvironment`, `workerGeneration`, and
a truncated SHA-256 hash as `threadKey`. It does not embed the raw Slack or
thread identifier, but it remains linkable by anyone holding a candidate value;
use a secret salt if operational requirements demand unlinkability. Do not put
raw Slack or thread identifiers into Modal tags.

Datadog receives a lifecycle transition counter and a live-duration histogram.
Useful initial monitors are:

- any `warm` worker older than its persisted `warmUntil` plus two sweep
  intervals;
- any live duration approaching `COMPADRE_MODAL_TIMEOUT_MS`;
- repeated `hibernate.failed` or `restore.failed` transitions;
- active sandbox count and worker-hours grouped by environment, provider, and
  dev-environment tag;
- snapshot restore failures before the seven-day retention boundary.

Tune `COMPADRE_T3_WORKER_WARM_TTL_MS` from observed follow-up behavior. Reducing
it lowers idle compute cost but makes quick follow-ups pay restore latency.
Avoid increasing CPU or memory requests to address rare bursts: first inspect
actual usage, then change the request only when the sustained workload needs it.

Sources: [Modal pricing](https://modal.com/pricing), [Sandbox resource and
billing behavior](https://modal.com/docs/guide/sandbox-resources), and
[filesystem snapshots](https://modal.com/docs/guide/sandbox-snapshots).

Run the deterministic and real-Modal predeployment gates in
[`modal-lifecycle-testing.md`](./modal-lifecycle-testing.md) before changing
warm-lease, timeout, snapshot, or resource settings.
