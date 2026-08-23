# Daytona harness cutover

## Boundary

```text
Slack / HTTP
     |
     v
Persistent Render relay ---------> Daytona sandbox
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

The relay is the controller. Daytona is an execution sandbox. Database and
private-network credentials stay on Render. A sandbox receives a separate
short-lived bearer token for each run. It can call only the TanStack tools that
the controller registered for that run.

The implementation mounts TanStack's transport-neutral bridge core on the
relay's public HTTPS origin. A random bridge ID and bearer token are created for
each run and removed when the harness closes. Individual tools do not implement
their own Daytona transport or authentication.

## Initial lifecycle

The first cutover uses one sandbox per run and deletes it after completion or
cancellation. This avoids orphaned persistent sandboxes until Compadre wires a
Postgres-backed `SandboxInstanceStore`, takeover fencing, and a detached-run
reaper. Thread transcripts remain durable in Postgres. Filesystem reuse is a
later stage.

Slack attachments are downloaded by the relay and uploaded into the sandbox
before the harness starts. Their prompt paths refer to the remote workspace.
The repository starts as a shallow clone of the configured branch to stay
within the sandbox disk budget. An agent can fetch more history when required.

## Configuration

The persistent relay owns orchestration. Production requires:

```bash
DAYTONA_API_KEY=...
COMPADRE_PUBLIC_URL=https://compadre.example.com
GITHUB_PERSONAL_ACCESS_TOKEN=...
```

Optional settings:

```bash
DAYTONA_TARGET=us
DAYTONA_API_URL=
COMPADRE_DAYTONA_SNAPSHOT=
COMPADRE_DAYTONA_WORKDIR=/home/daytona/workspace
COMPADRE_DAYTONA_CLI_ROOT=/home/daytona/.compadre-runtime
COMPADRE_DAYTONA_AUTO_STOP_MINUTES=40
COMPADRE_DAYTONA_AUTO_DELETE_MINUTES=10080
COMPADRE_DAYTONA_SKIP_CLI_SETUP=false
```

A prepared snapshot should contain the pinned Claude Code and Codex CLIs. Set
`COMPADRE_DAYTONA_SKIP_CLI_SETUP=true` only after a probe proves both commands
are available in that snapshot.

Every sandbox receives a Daytona-side auto-stop of at least 36 minutes and an
immediate auto-delete after it stops. Normal completion still deletes the
sandbox immediately. The Daytona lifecycle is an external cleanup backstop for
a relay process that is killed before its `finally` block runs.

## Verification gates

Run the normal build and test suite first. Then verify one controlled Slack
thread for each case:

1. A read-only repository question.
2. A repository edit and test run.
3. A host MCP tool call that reaches a Tailscale-only service.
4. A Postgres-backed tool call; confirm the database connection originates
   from Render, not Daytona.
5. A Slack image attachment.
6. Agent timeout and user cancellation.
7. Forced sandbox deletion during a run.
8. Relay restart during a run.

Do not make Daytona the default until every failure produces a terminal durable
event and a final Slack state. Relay restart recovery needs takeover support;
until then, keep the rollout limited and treat that gate as expected to fail.

The first cutover also assumes one relay instance. The active bridge contains
live tool closures and is process-local, so a load balancer must not send bridge
requests to another replica. Add instance-affine routing or a durable tool
dispatcher before scaling the controller horizontally.
