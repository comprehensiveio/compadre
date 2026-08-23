# Modal harness cutover

## Boundary

```text
Slack / HTTP
     |
     v
Persistent Render relay ---------> Modal sandbox
     |                               - Claude Code or Codex
     |                               - repository files
     |                               - shell, Git, builds, and tests
     |
     +--> Postgres
     +--> Slack
     +--> MCP and Tailscale services
              ^
              |
       authenticated TanStack tool bridge
```

The relay is the controller. Modal is an execution sandbox. Database and
private-network credentials stay on Render. A sandbox receives a separate
short-lived bearer token for each run. It can call only the TanStack tools that
the controller registered for that run.

The implementation mounts TanStack's transport-neutral bridge core on the
relay's public HTTPS origin. A random bridge ID and bearer token are created for
each run and removed when the harness closes. Individual tools do not implement
their own Modal transport or authentication.

## Lifecycle

Compadre uses one Modal sandbox per active turn. A successful persisted turn
captures a seven-day filesystem snapshot, stores the image ID through the
Postgres-backed `SandboxInstanceStore`, and terminates the sandbox. The next
turn restores from that image. One-shot runs terminate without snapshotting.
This preserves working-tree changes without paying for idle compute.

Slack attachments are downloaded by the relay and uploaded into the sandbox
before the harness starts. Their prompt paths refer to the remote workspace.
The repository starts as a shallow clone of the configured branch to stay
within the sandbox disk budget. An agent can fetch more history when required.

## Configuration

The persistent relay owns orchestration. Production requires:

```bash
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
COMPADRE_PUBLIC_URL=https://compadre.example.com
GITHUB_PERSONAL_ACCESS_TOKEN=...
```

Optional settings:

```bash
MODAL_ENVIRONMENT=
COMPADRE_MODAL_APP=compadre
COMPADRE_MODAL_BASE_IMAGE=node:22
COMPADRE_MODAL_WORKDIR=/workspace
COMPADRE_MODAL_CLI_ROOT=/opt/compadre-runtime
COMPADRE_MODAL_TIMEOUT_MS=7200000
COMPADRE_MODAL_SNAPSHOT_TTL_MS=604800000
COMPADRE_MODAL_CPU=0.5
COMPADRE_MODAL_CPU_LIMIT=2
COMPADRE_MODAL_MEMORY_MIB=2048
COMPADRE_MODAL_MEMORY_LIMIT_MIB=8192
COMPADRE_MODAL_SKIP_CLI_SETUP=false
```

A prepared base image should contain the pinned Claude Code and Codex CLIs. Set
`COMPADRE_MODAL_SKIP_CLI_SETUP=true` only after a probe proves both commands
are available in that snapshot.

Persisted conversation threads restore their latest Modal snapshot, including
the Git working tree and installed dependencies. Snapshots expire after seven
days by default, matching thread retention. If durable thread persistence is
unavailable, Compadre falls back to one-shot cleanup.

## Verification gates

Run the normal build and test suite first. Then verify one controlled Slack
thread for each case:

1. A read-only repository question.
2. A repository edit and test run.
3. A host MCP tool call that reaches a Tailscale-only service.
4. A Postgres-backed tool call; confirm the database connection originates
   from Render, not Modal.
5. A Slack image attachment.
6. Agent timeout and user cancellation.
7. Forced sandbox deletion during a run.
8. Relay restart during a run.

Do not deploy until every failure produces a terminal durable event and a final
Slack state. Relay restart recovery needs takeover support; treat that gate as
expected to fail until it is implemented.

The first cutover also assumes one relay instance. The active bridge contains
live tool closures and is process-local, so a load balancer must not send bridge
requests to another replica. Add instance-affine routing or a durable tool
dispatcher before scaling the controller horizontally.
