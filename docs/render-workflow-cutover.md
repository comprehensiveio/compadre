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
- Workflow: `compadre-agent-postgres-spike-v3`
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

The persistent relay exports through the existing Datadog Agent. Ephemeral
Workflow tasks have no colocated Agent, so they use Datadog's agentless OTLP
trace intake with `dd-otlp-source=llmobs`. Both use `DD_ENV=workflow-spike` in
the playground. A verified Workflow trace includes the task root, agent root,
startup phases, memory high-water marks, provider/model, and the deployed Git
revision. Production must replace that environment tag during cutover.

## Immediate post-cutover: canonical thread memory

> **Temporary implementation plan:** Delete this section after canonical
> thread memory and workspace-state persistence are implemented, tested, and
> documented in their permanent architecture or operations documentation.

Keep the initial cutover on the existing Slack-history behavior. After the
Workflow topology is stable, make server-side TanStack persistence the
canonical history for each Slack `thread_ts`; Slack remains a supplemental
source for ambient human messages that arrived while Compadre was not tagged.

For each mention, the relay should:

1. Acquire a distributed lock for the Slack thread, then reload state after the
   lock is held.
2. Load the bounded provider-neutral transcript, rolling summary, provider
   session references, and workspace/artifact references from Postgres.
3. Fetch Slack messages newer than the stored Slack checkpoint, preserving
   author, timestamp, and order. Deduplicate them by Slack event/message ID.
4. Supply that Slack delta as supplemental channel context rather than copying
   the entire Slack thread into the canonical transcript.
5. Persist the accepted user turn, terminal assistant turn, derived memory,
   artifact references, and the new Slack checkpoint after the run.

The existing durable AG-UI run log remains the detailed audit record for tool
calls, intermediate messages, usage, and errors. Do not replay every raw event
into future model context; retrieve details from that log only when relevant.
Provider-native session IDs are an optimization, never the source of truth, so
switching between Claude Code and Codex can always fall back to the neutral
transcript.

Thread history does not make filesystem state durable. The initial contract is
deliberately explicit: source changes needed by a later request go to a Git
branch or PR, and meaningful non-repository artifacts go to the Slack thread.
The Slack prompt warns that local-only state is disposable. A managed durable
sandbox can replace this contract later if usage justifies it; do not build a
custom workspace snapshot system for the initial cutover. Canonical thread
memory remains useful independently of that future filesystem enhancement.

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
