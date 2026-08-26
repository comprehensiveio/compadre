# T3 Code + Compadre native-worker experiment

> The original `compadre` provider remains a rollback checkpoint. The active
> branch keeps T3's built-in Codex and Claude provider identities and replaces
> only their execution adapter when `COMPADRE_NATIVE_T3_URL` is configured.
> Compadre is the worker coordinator and MCP/tool host, not a user-selectable
> provider.

This experiment keeps T3 Code's web client, central project/thread
orchestration, model picker, and canonical runtime events on Render. A native
Codex or Claude turn is sent to Compadre's `/hosted/t3/chat` stream, which
routes it to one Modal-hosted T3 worker per central thread. Compadre remains
responsible for worker routing, worker snapshot recovery, MCP/tool hosting, and
Slack delivery; central T3 owns the browser read model.

The companion patch records the initial adapter checkpoint based on upstream T3 Code commit
`994372ba43810e64027c537231da200988faa7ca` and was proven locally on
2026-08-25. It adds an opt-in provider adapter behind
`COMPADRE_PROVIDER_URL`; without that variable, T3's Codex driver is
unchanged. The maintained fork branch is the source of truth for the later
hosted-readiness, model-selection, terminal-state, cancellation, attachment,
and native-provider commits. Apply the patch only to reproduce the first local
spike; use the maintained fork branch for the current experiment.

The maintained experiment branch is
`https://github.com/comprehensiveio/t3code/tree/experiment/compadre-modal-provider`.
With `COMPADRE_NATIVE_T3_URL` configured, its Codex and Claude drivers use the
remote adapter without requiring local provider CLIs or logins on Render. The
normal provider and model choices remain visible in T3. Leaving that variable
unset preserves upstream local-driver behavior.

## Proven flow

```text
Slack / API ----┐
                +-> central T3 server and event log on Render
T3 web client --┘          |
                           +-> POST /hosted/t3/chat
                           +-> Compadre worker router + snapshot archive
                           +-> one Modal T3 worker for this thread
                           +-> native Codex or Claude harness
                           +-> incremental native T3 runtime events
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

## Run central T3 locally

Export the same `COMPADRE_API_KEY` already stored in Compadre's `.env.local`,
then start the patched T3 checkout:

```bash
COMPADRE_NATIVE_T3_URL=http://127.0.0.1:3100/hosted/t3/chat \
COMPADRE_API_KEY="$COMPADRE_API_KEY" \
npm run dev -- --home-dir "$PWD/.t3"
```

Open the pairing URL printed by T3 and add a local project. The normal provider
picker offers Claude and Codex, and each provider's model picker is populated
by its native T3 driver snapshot. Do not set `COMPADRE_PROVIDER_URL`; that
enables the historical standalone Compadre provider instead.

## Verification

From the patched T3 checkout:

```bash
node_modules/.bin/vp test run \
  apps/server/src/provider/Layers/CompadreAdapter.test.ts

cd apps/server
../../node_modules/.bin/vp run typecheck
```

The focused adapter tests cover successful text streaming, failed runs,
backend cancellation, and image forwarding. Native-provider hydration and
Compadre-backed title generation have their own focused tests.
Both focused suites and the server typecheck pass; existing Effect diagnostic
suggestions elsewhere in T3 remain unchanged.

## Known gaps

- Text messages and basic tool lifecycle events are translated. Approvals,
  structured user input, usage, diffs, plans, and richer tool output still need
  first-class mappings.
- T3 Stop now cancels the corresponding Compadre run and Modal harness. The
  controller-side cancellation and MCP tool-bridge registries are process-local,
  so keep the canary at one Compadre instance until ownership is distributed.
  Do not begin canary runs during a rolling Compadre deploy; callbacks from a
  run on the draining instance can otherwise reach the replacement instance.
- The central adapter forwards attachment bytes, but `/hosted/t3/chat` does not
  yet materialize them into the native worker thread. Attachment parity remains
  a follow-up for this architecture.
- T3's local project/worktree is display and orchestration metadata only;
  Compadre still selects and clones the repository used in Modal.
- Explicit T3-to-Slack thread pairing now shares the canonical transcript and
  Modal snapshot lineage. T3 still lacks Slack-thread discovery, a pairing UI,
  and automatic import of Slack history into its own local event database.
- Worker snapshots are archived before stream projection, but the central SSE
  cursor itself is process-local. A dropped client can reload persisted T3
  events; exact transport resumption after a mid-turn Render replacement still
  needs snapshot-to-projection repair.

## Fork status

The experiment now uses a Comprehensive-owned fork and an isolated Render
project. The fork is intentionally limited to native remote-provider adapters
and their hosted integration behavior. Slack-thread discovery/pairing UX,
user-scoped authentication, and distributed run ownership remain the main
productization gates.
