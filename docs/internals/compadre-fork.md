# Comprehensive's T3 fork layer

> Hosted central T3 uses the existing Compadre PostgreSQL database in the
> `compadre_t3` schema (cut over 2026-09-05); controller tables remain in `public`.
> SQLite remains the local/desktop/Modal backend. Keep the Render disk and
> single-process deployment: reactor ownership, signing secrets/configuration
> and workspace restore still block disk removal. See
> `docs/internals/hosted-postgres-persistence.md` and
> `hosted/compadre/docs/runbooks/central-t3-postgres-cutover.md`.

The root of this monorepo is an intentional product fork of T3 Code.
Comprehensive uses the native T3 server, web application, Codex provider, and
Claude Code provider as the conversation system for Compadre. Compadre routes
provider execution to one isolated Modal environment per thread and exposes
Slack and HTTP as equal entrypoints to the same central T3 conversation. The
Compadre controller lives in the same repository under `hosted/compadre/`.

The canonical cross-stack change guide is
`.agents/skills/change-compadre-stack/SKILL.md` at the repo root. Load it
before changing a Compadre seam, database, deployment, or production flow. If
a T3 change makes that guide verifiably inaccurate, update it in the same
change; do not duplicate the guide here.

The fork should be capable of meaningful product changes while remaining cheap
to update from `pingdotgg/t3code`. The rule is not “never change upstream code.”
It is “concentrate each product difference behind a narrow seam.”

## Fork seams

| Seam                       | Comprehensive implementation                                                                                            | Upstream surface changed                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Hosted worker terminals    | `apps/server/src/terminal/CompadreTerminal.ts`, controller terminal service and shared gateway acquisition              | Terminal manager composition, explicit-start contract and terminal viewport                                       |
| Hosted preview readiness   | `auth/CompadrePreviews.ts`, web `compadrePreviews.tsx`, controller `routes/preview-readiness.ts`                        | Session-scoped preview provider and both sidebar layouts                                                          |
| Remote native execution    | `apps/server/src/provider/RemoteNativeProvider.ts` and the `Compadre*` provider layers                                  | Provider registry wiring only                                                                                     |
| Controller text generation | `apps/server/src/textGeneration/CompadreTextGeneration.ts`                                                              | Remote provider construction only                                                                                 |
| Runtime telemetry          | `apps/server/src/provider/ProviderRuntimeTelemetry.ts`                                                                  | Provider event observation hooks                                                                                  |
| Protocol durability        | Cursor-aware reconnect in `apps/server/src/provider/Layers/CompadreTransport.ts`                                        | No UI or storage changes                                                                                          |
| Hosted authentication      | `apps/server/src/auth/CompadreAuth.ts`, `CompadrePreviewGateway.ts`, and `CompadrePreviewActivationPage.ts`             | Server route/session composition                                                                                  |
| Controller MCP bridge      | `apps/server/src/mcp/CompadreMcpBridge.ts`                                                                              | Codex and Claude adapter hooks                                                                                    |
| Central persistence        | `persistence/Layers/Persistence.ts`, `Postgres.ts`, `CompadrePostgresSchema.ts`, importer and attachment object modules | Server/project CLI composition, engine transaction/publication, projection read/cursor and attachment write hooks |
| Hosted backup              | `apps/server/src/auth/CompadreBackup.ts`                                                                                | Server route composition                                                                                          |
| Operations diagnostics     | `apps/server/src/auth/CompadreOperations.ts` and `apps/web/src/components/operations`                                   | One server route, hosted web route, sidebar and command-palette entries                                           |
| Triggered prompts          | `apps/server/src/auth/CompadreTriggeredPrompts.ts` and `apps/web/src/components/settings/TriggeredPromptsSettings*`     | One proxy route layer, one settings section, trigger attribution in contracts and timeline                        |
| Message attribution        | migrations `043` and `044` plus command attribution hooks                                                               | Contracts, projection, and UI                                                                                     |
| Compadre product UI        | branding, session, sidebar, chat, usage, and CSS hooks in `apps/web`                                                    | Narrow components and styles                                                                                      |

Codex and Claude Code remain the provider identities shown to users. Compadre is
transport and orchestration, not a provider choice.

### Model discovery

The hosted provider snapshot refreshes through the normal T3 managed-provider
lifecycle. It has no model allowlist. The controller's authenticated
`GET /hosted/t3/providers/:provider/models` endpoint runs its pinned Codex CLI's
`model/list`, collects all pages, and returns native capability metadata.
Central T3 reuses the local Codex parser. The probe uses an isolated temporary
Codex home and the worker API credential; it never creates a thread or acquires
a Modal worker. The controller caches successful results for five minutes,
coalesces concurrent requests, and retains the last success during an outage.
This discovers the shared API execution catalog, not a particular user's
ChatGPT subscription entitlements.

Claude uses upstream T3's `ModelManifest`, `ClaudeModelCatalog`, and validated
adapter profiles (ported from upstream commit `035428368`). The manifest refreshes
hourly from upstream, with a disk cache and bundled offline fallback. Its model
capabilities drive both the picker and native Claude execution. Hosted discovery
filters against the controller-reported worker CLI pin; local discovery uses
the installed CLI version. Provider update-check settings gate manifest network
refreshes, matching upstream. Explicit Slack shortcuts remain environment-backed
defaults in `hosted/compadre/src/config.ts`.

Controller npm dependencies and Modal image pins must agree. New workers use
the pinned image; template and checkpoint restores reconcile the CLI packages
before installing the current T3 fork and starting its server. Already running
workers retain their binaries until replacement/restoration. Custom images with
`COMPADRE_MODAL_SKIP_CLI_SETUP=true` remain responsible for their own CLIs.

Deploy the controller before the web server for this additive endpoint. An older
controller produces a visible discovery warning; a prior successful catalog is
retained, while first discovery does not manufacture model choices.

### Preview indicator

The preview indicator reads `/api/compadre/previews/ready`, authenticated with
the hosted browser session. Central T3 forwards to the controller's separate
`/internal/previews/ready` endpoint using its service credential. Only thread
IDs, stable HTTPS preview URLs, and observation timestamps cross this seam.
The controller shares the existing bounded, cached environment observer with
operations diagnostics; these reads never provision or restore workers.
Only a running container with a responding port 3000 and an observation less
than 90 seconds old is advertised. The client polls once per 15 seconds while
visible, expires links locally, clears them on request failure, and scopes them
to the primary environment. An older controller's 404 becomes an empty result,
allowing web to deploy before API. Web and desktop share the sidebar component;
mobile navigation and local terminal status contracts are unchanged.

## Merge discipline

- Prefer additive files owned by the fork.
- Keep edits to upstream files to small construction or registration hooks.
- Do not copy upstream modules into Compadre.
- Do not reformat unrelated upstream code.
- Cover every fork seam through its public interface.
- Record new fork seams in the table above.
- Merge or rebase from the `upstream` remote regularly, before the delta grows.

UI and persistence changes are allowed when the product requires them. When
possible, implement them as new modules with one narrow hook into upstream UI or
server composition. A direct SQLite schema change is acceptable for a real T3
concept such as users or message actors, but it should be accompanied by a
migration and should not duplicate Compadre's Postgres execution records.

## Current ownership

Central T3’s configured database owns the canonical conversation, message attribution,
participants, usage projection, and browser sessions rendered by the hosted
UI. The Compadre controller's Postgres owns canonical users and Slack
identities, external-thread bindings, run/event delivery, worker identity,
leases, recovery metadata, and the Slack delivery outbox. Browser
authentication is exchanged through the controller and materialized as a T3
session; client-supplied display names are never authorization data.

While a hosted turn is running, another browser or Slack message is a native
T3 steer. `CompadreAdapter` keeps the original durable controller stream as
the single event reader, reuses the current orchestration turn id, and sends an
idempotent instruction to the controller run's `/steer` endpoint. The
controller queues setup-time instructions durably and otherwise forwards them
through the thread-scoped Modal T3 server's native Claude/Codex steering path.
No second controller run or terminal observer is created. During independent
controller/web rollout only, the adapter falls back to the older additive
`/chat` request when the controller reports that `/steer` is unsupported.

The controller (`compadre-api`) and T3 fork stack (`compadre-web`)
auto-deploy independently even from the same repository. Contracts crossing
that seam must remain backward compatible through the rollout, and the
cross-stack skill defines the safe deployment order and live verification
requirements.

### Central PostgreSQL migration maintenance

Hosted central T3 uses the existing application database’s `compadre_t3` schema;
the controller keeps its `public` tables and Drizzle migration history. SQLite
remains local/desktop/development/Modal persistence. The two applications reuse
the existing database credential. Their migration tools and table ownership stay
independent; no cross-schema joins are introduced.

On every upstream SQLite migration, inspect and reproduce the applicable schema
and data transformation in a new ordered central PostgreSQL migration. Update
`SQLITE_SCHEMA_VERSION`, then run the schema/import parity test and shared
repository contracts on both backends. Do not copy migrations from another fork
or upstream without comparing Compadre’s attribution/participants and
authentication fields.
The parity test intentionally fails when the SQLite migration tip changes. Keep
runtime persistence selection dynamic and server composition hooks additive.

Hosted diff reads use [durable workspace reviews](hosted-workspace-reviews.md).
The controller publishes immutable checkpoint patches and file context; the
central server's `CompadreReview` adapter reads them without accessing Modal.

The hosted terminal direct transport adds `terminal.connection` to the shared
contract, `terminal/DirectTerminal.ts` to the worker HTTP routes and RPC handler,
and `state/directTerminal.ts` to client-runtime terminal atoms. The controller
terminal service brokers terminal-bound grants through the existing worker
lifecycle interface. See [Hosted worker terminals](hosted-worker-terminals.md).
