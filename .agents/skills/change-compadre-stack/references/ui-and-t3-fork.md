# UI and hosted T3 fork changes

> Hosted central T3 uses the existing Compadre PostgreSQL database in the
> `compadre_t3` schema (cut over 2026-09-05); controller tables remain in `public`.
> SQLite remains the local/desktop/Modal backend. Keep the Render disk and
> single-process deployment: reactor ownership, signing secrets/configuration
> and workspace restore still block disk removal. See
> `docs/internals/hosted-postgres-persistence.md` and
> `hosted/compadre/docs/runbooks/central-t3-postgres-cutover.md`.

Read the complete root `AGENTS.md` and
`docs/internals/compadre-fork.md` before changing the UI/server stack. Their
instructions about
worktree safety, live T3 data, contracts, surfaces, and focused verification
apply in addition to this skill.

## Pick the correct surface

Production Compadre UI and central conversation state live at the monorepo
root (the T3 Code fork layer):

- `apps/web`: React/Vite web UI deployed at
  `compadre.comprehensive.io`
- `apps/server`: WebSocket/HTTP server, orchestration, persistence, providers,
  auth, backup, and Compadre adapters
- `packages/contracts`: typed wire contracts shared by server and clients
- `packages/client-runtime`: behavior shared by clients

The `hosted/compadre/web/` and `hosted/compadre/dist-web/` paths are not the
production hosted T3 UI. Do not implement a product UI change there.

Upstream T3 supports web, desktop, and mobile. Compadre production currently
serves web, but shared contracts and client-runtime changes can affect all
clients. Follow T3's surface checklist and make an explicit decision for each
applicable client rather than assuming a web component is the whole feature.

## Keep the fork maintainable

Compadre is an intentional T3 product fork, not a temporary patch set:

- Prefer new Compadre-owned modules with one narrow registration/composition
  hook into upstream.
- Keep direct edits to upstream files small and avoid unrelated formatting.
- Add every new seam to `docs/internals/compadre-fork.md`.
- Preserve native `codex` and `claudeAgent` identities. Remote execution is
  an adapter behind those providers.
- Put durable conversation and UI concepts in central T3 persistence (hosted PostgreSQL; SQLite locally). Do not mirror
  Compadre Postgres control tables into SQLite.
- Keep the `upstream` remote and rehearse upstream merges periodically.

Common Compadre seams include:

- remote provider execution and reconnect:
  `apps/server/src/provider/RemoteNativeProvider.ts`,
  `CompadreAdapter.ts`, and `CompadreTransport.ts`
- controller text generation:
  `apps/server/src/textGeneration/CompadreTextGeneration.ts`
- runtime telemetry:
  `apps/server/src/provider/ProviderRuntimeTelemetry.ts`
- Slack-backed browser session support:
  `apps/server/src/auth/CompadreAuth.ts` and
  `apps/web/src/compadreSession.tsx`
- controller MCP forwarding:
  `apps/server/src/mcp/CompadreMcpBridge.ts`
- authenticated operations diagnostics:
  `apps/server/src/auth/CompadreOperations.ts` and
  `apps/web/src/components/operations/ThreadOperationsPage.tsx`; the source
  snapshot is owned by the controller's `/internal/operations/threads` API

Search before relying on this list; keep the fork document current when a seam
moves.

## UI change workflow

1. Locate the event/projection or client state that owns the displayed value.
   Do not patch rendered text if the real defect is missing protocol data.
2. Update shared contracts first when data crosses server/client boundaries.
3. Put Compadre-only presentation behind a small hosted-mode component or
   selector when upstream behavior should remain intact.
4. Test the logic/state helper and the rendered behavior at the narrowest
   useful level.
5. Run focused T3 commands as directed by the root `AGENTS.md`, for example:

   ```bash
   vp test run <changed-test-files>
   vp run --filter @t3tools/web typecheck
   ```

   Do not run the fork's repo-wide checks unless requested; CI owns them.

6. For a visible change, verify in an authenticated production-like web client
   when the task authorizes browser use. Exercise populated data, hover and
   empty states, narrow layouts, and a Slack-linked thread when relevant.

## Central server or auth change

Test both the server command/event flow and the client projection. Compadre
browser auth is not a parallel user database: the controller verifies Slack
OIDC and issues a short-lived handoff; central T3 exchanges it and owns the
persisted browser session.

For auth changes, preserve:

- state, nonce, issuer, audience, signature, expiry, and workspace checks;
- short-lived single-use handoff exchange;
- server-derived actor attribution;
- rejection of legacy pairing browser sessions in hosted mode;
- service/bearer access for controller integration;
- no Slack credential in the browser, transcript, Modal environment, or logs.

## Deployment result

Merging `main` auto-deploys Render service `compadre-web` (which builds from
the monorepo root). It does not redeploy `compadre-api` or existing Modal
workers. Hosted PostgreSQL migrations run explicitly in Render pre-deploy;
SQLite migrations still run at local/desktop/worker startup.

Verify the deployed commit, Render health, authenticated login, an existing
thread, a new message, and any changed live event behavior. A successful static
asset request alone does not prove that the server, persistence migration, or
WebSocket projection works.
