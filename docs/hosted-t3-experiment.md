# Hosted T3 experiment

This branch tests the product shape suggested by T3 Code: a coding-agent
conversation that can be opened from a browser, while Compadre remains the
hosted controller and Modal remains the execution boundary.

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

The next decision gate is Slack-thread discovery/pairing UX and user-scoped
authentication, not whether shared Slack/T3/Modal identity is technically
possible.
