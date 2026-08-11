# Render Workflow cutover

## Target shape

```text
Slack Events / authenticated HTTP
                |
                v
Persistent relay Web Service ---- starts ----> Render Workflow task (4 GB)
                |                                      |
                | tails ordered AG-UI events           | appends before delivery
                v                                      v
                        Render Postgres
                |
                v
       Slack status, text, and reactions
```

The relay owns ingress, Slack API calls, and delivery state. A Workflow task
owns one agent turn and its disposable repository checkout. They communicate
through the TanStack `RunStore` and `StreamDurability` contracts in Postgres,
not through a live socket. A slow or dead client therefore cannot hold the
agent process open, and a dead Workflow is reported by the relay's task monitor
instead of leaving Slack in a permanent processing state.

## Local development

Postgres is optional locally. The memory backend and in-process Workflow runner
exercise the same launch and replay boundaries:

```bash
COMPADRE_DURABILITY_BACKEND=memory \
COMPADRE_WORKFLOW_RUNNER=local \
COMPADRE_WORKFLOW_RELAY_ENABLED=true \
npm run dev

COMPADRE_WORKFLOW_RELAY_URL=http://localhost:3100 \
npm run workflow:relay-probe -- "Reply with exactly: local relay works"
```

Unit tests use this mode and never need Render or a database. Set
`COMPADRE_TEST_DATABASE_URL` only for the Postgres adapter integration test.

## Playground deployment

The isolated test stack is in Render project `compadre`, environment
`workflow-spike`:

- Relay: `compadre-workflow-relay-spike`
- Workflow: `compadre-agent-postgres-spike-v2`
- Database: `compadre-agent-spike-db`

The Workflow API is currently workspace-scoped rather than environment-scoped.
Consequently, Render environment network isolation must remain disabled for the
Workflow to reach the project's private Postgres address. This was verified by
an otherwise identical durability probe: isolation caused a two-minute
connection failure; disabling it restored a successful replay in 6.5 seconds.

Run the deployed streaming and reconnect check with:

```bash
COMPADRE_WORKFLOW_RELAY_URL=https://compadre-workflow-relay-spike.onrender.com \
npm run workflow:relay-probe -- "Reply with exactly: deployed relay works"
```

The probe reports launch, first event, text, completion, and reconnect timing.
It never prints response text or credentials.

## Delivery and failure semantics

- The Workflow persists each AG-UI event before the relay observes it.
- Slack delivery still uses the existing bounded `SlackStream` behavior and its
  native-stream-to-message-update fallback.
- A Workflow task failure is monitored independently of the event stream and
  reaches the existing Slack error path, which clears status and adds the
  failure reaction.
- If the relay itself restarts, the existing Slack reaction reconciliation
  converts orphaned thinking markers to failure markers. Exact continuation of
  an already-started Slack message is a later delivery-checkpoint enhancement;
  users are not left waiting indefinitely in the meantime.
- Automatic Workflow retries stay disabled until mutating agent tools and Slack
  delivery have durable idempotency keys.

## Production cutover

1. Create a paid production Postgres instance in the `compadre` project. The
   free playground database expires and is not a production dependency.
2. Create the production Workflow and relay from one reviewed commit. Set both
   to the same Postgres URL and production secrets.
3. Set `DD_SERVICE=compadre` and the established production `DD_ENV` on the
   production resources. Do not carry over `DD_ENV=workflow-spike`.
4. Leave `COMPADRE_SLACK_WORKFLOW_ENABLED=false`; run health, durability, agent,
   streaming, reconnect, and forced-failure probes.
5. Enable `COMPADRE_SLACK_WORKFLOW_ENABLED=true` on the new relay and test a
   controlled Slack thread.
6. Move the Compadre custom domain (or update the Slack Events Request URL) to
   the new relay. DNS alone is sufficient only when Slack already targets that
   custom hostname.
7. Observe successful Slack completions and failure signaling, then suspend the
   old service. Keep rollback available by restoring the prior hostname or
   Slack Request URL.

The old persistent service remains unchanged until steps 5–7.
