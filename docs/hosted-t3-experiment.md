# Hosted T3 experiment

This branch tests the product shape suggested by T3 Code: a coding-agent
conversation that can be opened from a browser, while Compadre remains the
hosted controller and Modal remains the execution boundary.

## Current native-T3 direction

The current experiment no longer treats Compadre as a T3 provider. Slack, the
HTTP coordinator, and the simulator dispatch into T3's built-in Codex or Claude
provider. Each external conversation owns one native T3 thread in one Modal
sandbox. The hosted T3 web app pairs directly with that environment and renders
the canonical transcript, reasoning, tool calls, diffs, terminal, and native
controls. Slack is a concise projection of the same turn: assistant text plus a
one-time “View details in T3” link.

```text
Slack ──> Compadre coordinator ──> native T3 server in Modal ──> Codex/Claude
  ^                 |                         |
  |                 └── assistant text       └── full T3 event stream
  └── hosted T3 deep link ────────────────────────────────┘
```

T3 chooses the provider when the thread starts and does not switch providers
inside an established thread. A new Slack thread is therefore required to move
between Codex and Claude; T3's normal model picker remains available for the
chosen provider. This is a native T3 invariant, not a Compadre restriction.

The first experiment reused the useful seams—the chat interaction model,
streamed tool activity, durable thread identity, and resumable client
behavior—on top of Compadre's existing TanStack AI event log. A reproducible
T3 provider-adapter patch now proves that contract. The experiment is also
published on the Comprehensive fork at
`comprehensiveio/t3code:experiment/compadre-modal-provider`.

## Architecture

```text
Slack Events ──┐
               ├─> Compadre controller ─> Postgres durable thread/event log
Browser UI ────┘             │
                             ├─> Modal sandbox (Codex or Claude Code)
                             └─> Slack delivery for explicitly linked threads
```

The browser is not a second agent backend. `POST /hosted/chat` starts the same
durable workflow launcher used by the relay, and the response replays the same
AG-UI event log Slack consumes. `GET /hosted/chat?threadId=...` reconstructs the
canonical transcript. A dropped browser connection can rejoin by durable run
ID without starting another Modal task.

## Local use

The experiment needs durability, even locally, because hydration and stream
resumption are part of the contract.

```bash
cp .env.example .env.local
# Set COMPADRE_API_KEY plus the normal Modal/provider credentials.
# Set COMPADRE_DURABILITY_BACKEND=memory for an ephemeral local test.
# Set COMPADRE_HOSTED_T3_ENABLED=true.
npm install
npm run build
npm run dev
```

Open `http://localhost:3100/hosted` and enter `COMPADRE_API_KEY`. For frontend
iteration, run `npm run dev:web` alongside `npm run dev` and open Vite on port
5173.

### Native T3 directory mode

The newer architecture is available independently of the original AG-UI
surface:

```bash
COMPADRE_T3_DIRECTORY_ENABLED=true \
COMPADRE_T3_SLACK_ENABLED=true \
COMPADRE_T3_HOSTED_APP_URL=http://localhost:5733 \
COMPADRE_DURABILITY_BACKEND=memory \
npm run dev
```

Render stores only the credential-free directory and routing metadata. The first message creates one
Modal sandbox containing one native T3 server and one native T3 thread.
Follow-up messages, refresh, cancellation, and “Open native T3” all resolve the
same binding. The central UI is T3's existing hosted web app—not Compadre's
diagnostic directory UI. Merely listing metadata does not wake a sandbox. Codex
and Claude Code remain T3-native harnesses and do not route execution back
through TanStack AI.

The current local/deployed limitation is hard sandbox expiry: reconnect is
proven while Modal still exposes the sandbox, but T3's data directory is not
yet snapshotted and restored into a replacement sandbox.

To exercise the Slack ingress shape without sending anything to Slack, run:

```bash
COMPADRE_T3_SLACK_ENABLED=true \
COMPADRE_T3_HOSTED_APP_URL=http://localhost:5733 \
npm run slack:simulate -- --claude-code Reply with exactly: SLACK-SIM-OK
```

The native simulator uses the real T3 gateway, thread persistence, Modal
sandbox, T3 provider driver, Slack prompt, assistant streaming, and hosted deep
link. Only Slack API delivery is synthetic. Without the native flag it retains
the legacy TanStack workflow simulator for checkpoint comparison.

To open a Slack-originated conversation, use its canonical Compadre thread ID
(currently the Slack thread timestamp). The existing transcript will hydrate
when the browser and production relay share the same Postgres durability
database. To make new browser turns appear in Slack, enter the channel ID and
thread timestamp in “Mirror to Slack” once. The binding is durable metadata.
That operation also aliases the browser/T3-native id to the Slack-backed
canonical thread, so history, locks, provider sessions, and Modal snapshot
lineage are shared in both directions.

## Parallel deployment

The isolated canary is deployed in Render's `Compadre T3 Experiment` project,
inside its `Experiment` environment:

- T3 UI: `https://t3code-compadre-experiment.onrender.com`
- Compadre controller: `https://compadre-t3-experiment.onrender.com`
- Compadre database: `compadre-t3-experiment-postgres`
- T3 state: a 1 GB persistent disk mounted at `/var/data`

The environment has private-network isolation enabled. The canary has its own
database and API key, so it cannot hydrate production Slack threads unless a
later, explicit trial changes that boundary.

Configure the experiment with the normal relay/Modal credentials plus:

```text
COMPADRE_HOSTED_T3_ENABLED=true
COMPADRE_DURABILITY_BACKEND=postgres
COMPADRE_PUBLIC_URL=https://<experiment-host>
COMPADRE_PROCESS_ROLE=hosted-experiment
```

Important isolation rules:

- Leave the Slack App Events Request URL pointed at the primary
  `compadre-relay`. The experimental service must not receive duplicate Slack
  event deliveries.
- Give `COMPADRE_PUBLIC_URL` the experimental hostname. Modal host-tool calls
  for browser-started runs must return to the service that owns that run.
- Set `SLACK_BOT_TOKEN` only if browser-started turns should mirror into linked
  Slack threads.
- Set `COMPADRE_HOSTED_SLACK_DELIVERY_ENABLED=false` to suppress outbound Slack
  delivery during a synthetic probe while retaining Slack MCP credentials.
- Do not make the experiment a Slack recovery owner. Its distinct
  `COMPADRE_PROCESS_ROLE` keeps the primary relay responsible for recovery.
- Use the same database only for the real-thread trial. A separate database is
  safer for synthetic testing but cannot hydrate production Slack transcripts.
- Do not route production traffic or change the primary service's feature flag
  during the experiment.

The current authentication is intentionally narrow: all hosted routes are
behind the shared `COMPADRE_API_KEY`, and any authenticated tester who knows a
thread or run ID can read it. Before broader use, replace that boundary with
user identity, thread ownership, audit logging, and a server-side session so an
API key is not retained in browser storage.

The T3 Stop action calls `POST /hosted/runs/:runId/cancel`, which aborts the
active controller run and tears down the Modal harness instead of only closing
the browser stream. Cancellation ownership is currently in process, so keep the
experiment at one Render instance until run ownership or cancellation requests
are coordinated through shared storage.

## T3 provider-adapter result

The comparison is complete: T3's server exposes a provider-adapter boundary
that can consume Compadre's AG-UI stream through a small opt-in adapter. A real
two-turn T3 web -> local Compadre -> Modal run succeeded, including Compadre
session resumption. A paired-id Modal probe also restored one Slack-backed
workspace from a T3-native id and hydrated the combined transcript. The
reproducible upstream patch and current limitations are documented in
[`experiments/t3code/README.md`](../experiments/t3code/README.md).

The Render canary also completed a browser -> T3 -> Compadre -> Modal -> T3
turn against `comprehensiveio/comp`. After a T3 redeploy, the browser pairing,
project, thread, and transcript survived on disk. A follow-up used the same
Compadre thread, logged `resumed=true`, restored its Modal snapshot, and recalled
the prior repository remote. Slack delivery remained disabled throughout.

## Capability audit

The experiment preserves the existing `/prompt`, generic webhook, signed Slack
Events, AG-UI, durable Workflow, MCP, PR-watch, and Slack recovery code paths.
The isolated service deliberately does not own real Slack ingress, recovery, or
PR watches, so it cannot duplicate production work.

The browser path now has per-turn Claude Code/Codex selection, persistent
threads and Modal snapshots, real backend cancellation, resumable streams, API
run status, and image attachment forwarding. Modal sandboxes receive Compadre's
skills and prompts, all configured MCP tools, plus the same practical command
line set used by the app (`git`, `curl`, `jq`, `psql`, `gh`, `rg`, `pnpm`, and
the pinned Claude/Codex CLIs).

The T3 fork now exposes Compadre as its own provider instead of disguising it
as Codex. Its auxiliary commit, PR, branch, and thread-title generation also
uses Compadre's authenticated `/prompt` API. For Slack-bound browser turns, the
agent prompt includes the canonical channel and thread coordinates required by
custom Slack tools such as `slack_watch_comp_pr_deployment`. TanStack's Slack
tool names are normalized to the historical Compadre names, and generated
Modal files are temporarily materialized on the relay when
`slack_upload_file` executes there.

The isolated Render canary has also exercised read-only calls through S3,
Vitally, Google Workspace, and Postgres. Postgres uses the production database's
dedicated read-only role over its external TLS endpoint; no write-capable
database credentials were added to the experiment.

Remaining product gaps are user-scoped authentication, a Slack discovery and
pairing UI, multi-instance cancellation and tool-bridge ownership, and
T3-native presentation for remote workspace diffs, checkpoints, shells, and
interactive approval or elicitation requests. Until the in-memory tool bridge
is distributed, keep the canary at one instance and avoid starting a run during
a rolling deploy: a Modal callback can otherwise land on the replacement
instance before the bridge registration moves. These are
integration/productization work rather than evidence that the shared
T3/Slack/Modal thread model is infeasible.
