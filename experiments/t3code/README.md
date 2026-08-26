# T3 Code + Compadre provider experiment

This experiment keeps T3 Code's web client, project/thread orchestration, and
canonical runtime events while sending provider turns to Compadre's hosted
AG-UI route. Compadre remains responsible for durable conversation state,
Modal sandbox execution, Slack delivery, and provider selection.

The companion patch is based on upstream T3 Code commit
`994372ba43810e64027c537231da200988faa7ca` and was proven locally on
2026-08-25. It adds an opt-in provider adapter behind
`COMPADRE_PROVIDER_URL`; without that variable, T3's Codex driver is
unchanged.

The maintained experiment branch is
`https://github.com/comprehensiveio/t3code/tree/experiment/compadre-modal-provider`.
It also marks the provider ready when `COMPADRE_PROVIDER_URL` is configured, so
a hosted T3 server does not need a local Codex executable or OpenAI login.

## Proven flow

```text
T3 web client
  -> local T3 server
  -> POST http://127.0.0.1:3100/hosted/chat
  -> local Compadre workflow relay
  -> Modal sandbox + Claude Code
  -> AG-UI SSE
  -> T3 canonical runtime events
  -> T3 web client
```

The local smoke test completed two turns through this path. The first rendered
`T3 WEB TO MODAL OK` in T3. The second asked the agent to repeat its immediately
previous reply; Compadre reported `resumed=true` and T3 rendered the same
answer, proving that conversation continuity survives across turns.

A second local proof paired the T3 id `t3-local-pair-proof` with a synthetic
Slack thread id. A first Modal sandbox wrote `PAIRING-SNAPSHOT-OK`, snapshotted,
and terminated. A turn sent under the T3 id then resolved to the Slack-backed
canonical conversation, logged `resumed=true`, restored the snapshot into a
new physical sandbox, and returned `PAIRING-SNAPSHOT-OK SECOND SIDE COMPLETE`.
Hydration through the T3 id returned the combined six-message transcript.

The deployed Render canary completed the same flow over public HTTPS. T3
streamed `RENDER-MODAL-OK` from a real Modal sandbox working in `/workspace`
with `https://github.com/comprehensiveio/comp.git` as its origin. After a T3
redeploy, the persistent disk retained the browser pairing, project, thread,
and transcript. A post-redeploy follow-up returned `DURABILITY-OK`; Compadre
logged `resumed=true` and restored the prior Modal snapshot.

## Apply the T3 patch

```bash
git clone https://github.com/pingdotgg/t3code.git
cd t3code
git checkout 994372ba43810e64027c537231da200988faa7ca
git switch -c experiment/compadre-modal-provider
git am /path/to/compadre/experiments/t3code/0001-compadre-provider-adapter.patch
pnpm install --frozen-lockfile
```

## Run Compadre locally

Start from the Compadre checkout with the normal Modal and model credentials
in `.env.local`:

```bash
COMPADRE_HOSTED_T3_ENABLED=true \
COMPADRE_DURABILITY_BACKEND=memory \
COMPADRE_PUBLIC_URL=https://compadre.invalid \
COMPADRE_AGENT_PROVIDER=claude-code \
COMPADRE_HOSTED_SLACK_DELIVERY_ENABLED=false \
GITHUB_REPO_URL=https://github.com/octocat/Hello-World.git \
REPO_BRANCH=master \
JAM_MCP_PAT=local-placeholder \
npm run dev
```

The placeholder public URL is sufficient only for a no-tool smoke test. Modal
cannot reach loopback, so any turn that invokes a relayed host tool needs a real
HTTPS tunnel pointing at the local Compadre server.

`COMPADRE_HOSTED_SLACK_DELIVERY_ENABLED=false` suppresses browser-to-Slack
mirroring during local probes without removing `SLACK_BOT_TOKEN`, which the
agent may still need for Slack MCP access. Omit the flag or set it to `true`
when testing real cross-surface delivery.

## Pair a T3 thread with Slack

Once both native ids are known, bind them through Compadre:

```bash
curl --request POST \
  --header "Authorization: Bearer $COMPADRE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"channelId":"C123","threadTs":"1712345678.000100"}' \
  http://127.0.0.1:3100/hosted/threads/T3_THREAD_ID/slack
```

Compadre keeps the T3 id as an alias and uses the Slack thread id as the
canonical conversation id. Subsequent T3 turns and hydration resolve the alias
before transcript lookup, run creation, locking, provider-session resumption,
or Modal snapshot restoration. A thread cannot be silently rebound to a
different workspace. Pair a newly created T3 thread before its first Compadre
turn; pairing returns `409` rather than orphaning an independently accumulated
T3 transcript. Automatic history merging is not part of this slice.

## Run T3 locally

Export the same `COMPADRE_API_KEY` already stored in Compadre's `.env.local`,
then start the patched T3 checkout:

```bash
COMPADRE_PROVIDER_URL=http://127.0.0.1:3100/hosted/chat \
COMPADRE_PROVIDER_AGENT=claude-code \
COMPADRE_API_KEY="$COMPADRE_API_KEY" \
npm run dev -- --home-dir "$PWD/.t3"
```

Open the pairing URL printed by T3, add a local project, and choose a Codex
model. The Codex selection is currently the UI slot that activates the
experimental adapter; `COMPADRE_PROVIDER_AGENT` determines which harness
Compadre actually runs.

## Verification

From the patched T3 checkout:

```bash
node_modules/.bin/vp test run \
  apps/server/src/provider/Layers/CompadreAdapter.test.ts

cd apps/server
../../node_modules/.bin/vp run typecheck
```

The focused adapter tests cover successful text streaming and failed runs.
The hosted-provider status behavior is covered in `ProviderRegistry.test.ts`.
Both focused suites and the server typecheck pass; existing Effect diagnostic
suggestions elsewhere in T3 remain unchanged.

## Known gaps

- T3's selected model/provider label does not yet reflect the harness Compadre
  actually runs.
- Interrupting in T3 stops local consumption but does not yet cancel the
  corresponding Compadre/Modal workflow.
- Text messages and basic tool lifecycle events are translated. Approvals,
  structured user input, usage, diffs, plans, and richer tool output still need
  first-class mappings.
- T3's local project/worktree is display and orchestration metadata only;
  Compadre still selects and clones the repository used in Modal.
- Explicit T3-to-Slack thread pairing now shares the canonical transcript and
  Modal snapshot lineage. T3 still lacks Slack-thread discovery, a pairing UI,
  and automatic import of Slack history into its own local event database.
- The adapter currently occupies T3's Codex driver slot. A durable fork should
  add Compadre as its own provider driver and snapshot instead.
- T3's auxiliary title-generation reactor still attempts to launch a local
  Codex CLI. Turn execution succeeds, but automatic thread titles fall back to
  the user prompt until text generation is routed through Compadre.
- A direct Render service restart left the disk-backed T3 service returning
  502s during this trial. A normal Render redeploy recovered the service and
  retained all disk state; use redeploy for canary maintenance until this is
  understood.

## Fork status

The experiment now uses a Comprehensive-owned fork and an isolated Render
project. The fork is intentionally limited to the provider adapter and hosted
readiness behavior. The next slice should add Slack-thread discovery and
pairing UX before treating it as a product surface.
