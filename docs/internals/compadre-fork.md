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

| Seam                          | Comprehensive implementation                                                                                                                   | Upstream surface changed                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Hosted worker terminals       | `apps/server/src/terminal/CompadreTerminal.ts`, controller terminal service and shared gateway acquisition                                     | Terminal manager composition, explicit-start contract and terminal viewport                                       |
| Hosted preview telemetry      | `auth/CompadrePreviewTelemetry.ts`, controller preview activation and Modal allocation logs                                                    | HTML stream injection and authenticated central-only collector in `CompadrePreviewGateway.ts`                     |
| Hosted preview readiness      | `auth/CompadrePreviews.ts`, web `compadrePreviews.tsx`, controller `routes/preview-readiness.ts`                                               | Session-scoped preview provider and both sidebar layouts                                                          |
| Remote native execution       | `apps/server/src/provider/RemoteNativeProvider.ts` and the `Compadre*` provider layers                                                         | Provider registry wiring only                                                                                     |
| Controller text generation    | `apps/server/src/textGeneration/CompadreTextGeneration.ts`                                                                                     | Remote provider construction only                                                                                 |
| Runtime telemetry             | `apps/server/src/provider/ProviderRuntimeTelemetry.ts`                                                                                         | Provider event observation hooks                                                                                  |
| Protocol durability           | Cursor-aware reconnect in `apps/server/src/provider/Layers/CompadreTransport.ts`                                                               | No UI or storage changes                                                                                          |
| Hosted authentication         | `apps/server/src/auth/CompadreAuth.ts`, `CompadrePreviewGateway.ts`, and `CompadrePreviewActivationPage.ts`                                    | Server route/session composition                                                                                  |
| Controller MCP bridge         | `apps/server/src/mcp/CompadreMcpBridge.ts`                                                                                                     | Codex and Claude adapter hooks                                                                                    |
| Central persistence           | `persistence/Layers/Persistence.ts`, `Postgres.ts`, `CompadrePostgresSchema.ts`, importer and attachment object modules                        | Server/project CLI composition, engine transaction/publication, projection read/cursor and attachment write hooks |
| Hosted backup                 | `apps/server/src/auth/CompadreBackup.ts`                                                                                                       | Server route composition                                                                                          |
| Operations diagnostics        | `apps/server/src/auth/CompadreOperations.ts` and `apps/web/src/components/operations`                                                          | One server route, hosted web route, sidebar and command-palette entries                                           |
| Native delivery failure state | Optional error status on `thread.native-stream.close`; stable runtime-error command IDs and bounded SQL recovery in `ProviderRuntimeIngestion` | Native close decider and provider error ingestion; existing client error presentation                             |
| Triggered prompts             | `apps/server/src/auth/CompadreTriggeredPrompts.ts` and `apps/web/src/components/settings/TriggeredPromptsSettings*`                            | One proxy route layer, one settings section, trigger attribution in contracts and timeline                        |
| Requester commit credit       | `apps/server/src/auth/CompadreAccount.ts` and `apps/web/src/components/settings/AccountSettings.tsx`                                           | One proxy route layer for the signed-in user's own profile, one hosted-only General settings section              |
| Message attribution           | migrations `043` and `044` plus command attribution hooks                                                                                      | Contracts, projection, and UI                                                                                     |
| Compadre product UI           | branding, session, sidebar, chat, usage, and CSS hooks in `apps/web`                                                                           | Narrow components and styles                                                                                      |
| Hosted provider actions       | Typed durable dispatch; see [provider actions](hosted-provider-actions.md)                                                                     | Native compaction fields and presentation; hosted request/cancellation correlation                                |

Codex and Claude Code remain the provider identities shown to users. Compadre is
transport and orchestration, not a provider choice.

Hosted PR tool calls use `compadre/HostedPullRequestClient.ts` and
`HostedPullRequestRoutes.ts`, with controller relay/credential projection in
`hosted/compadre/src/t3/pull-request-access.ts`. The upstream MCP handlers retain
local behavior and delegate hosted calls to the canonical central thread. The
native event mapper explicitly excludes worker explicit-link state and exhaustively classifies
all event types. `HostedBranchTracking.ts` lets the existing PR discovery reactor
follow a single-thread Modal root checkout. Only branch/discovered-PR metadata
crosses the journal boundary, with project identity remapped centrally; hosted
central discovery/settlement must not consult Render's checkout for that branch.
See [native delivery ownership and rollout](native-event-rollout.md#pull-request-associations).

### Attachment prompts

Hosted adapters declare `attachmentPromptPaths: "remote"`. Central ProviderService
forwards attachment bytes and context without appending Render filesystem paths;
the worker adds paths after saving its own attachments. Keep local/desktop path
injection and captured-window accessibility context intact. Do not strip paths
from caller text: only the execution environment owns generated attachment paths.

### Model discovery

Hosted usage reads centrally replicated `context-window.updated` activities.
Native token snapshots do not necessarily carry `usageProvider` or `model`;
resolve those from the last persisted turn-start selection at the activity's
timestamp. Preserve explicit historical usage metadata when present. Restrict
this fallback to `compadre-native:` activities so local transcript scans are not
counted twice, and never reprice old turns using a thread's current model.

Codex token notifications must retain their provider turn ID through runtime
routing so usage joins the initiating message's attribution. Older hosted
activities without a turn ID recover attribution at read time from the same
native worker journal's active session in event-sequence order. Session clears
and worker identities are boundaries; a later steering request or the thread's
owner is not an attribution fallback. Missing links remain unattributed, and
the recovery does not rewrite events or change token totals.

Harness operations use the [hosted provider action contract](hosted-provider-actions.md).
Keep its capability discovery, typed dispatch, and native completion receipts
intact when merging upstream actions; never route them through prompt decoration.
Compaction presentation and normalized token fields are ported into their
upstream-owned files, not a parallel hosted widget. Keep the native journal
payload stable across replay and limit custom lifecycle handling to the hosted
transport boundary. The provider-action guide records the source upstream
commits and intentional remaining differences for future merges.

The hosted provider snapshot refreshes through the normal T3 managed-provider
lifecycle. It has no model allowlist. The controller's authenticated
`GET /hosted/t3/providers/:provider/models` endpoint runs its pinned Codex CLI's
`model/list`, collects all pages, and returns native capability metadata.
Central T3 reuses the local Codex parser. The model probe uses an isolated
temporary Codex home and the worker API credential. When the managed ChatGPT
subscription lane is enabled and idle, the same response is enriched with an
account and `account/rateLimits/read` snapshot from a second temporary Codex
home. That read holds the lane lock, persists any refreshed auth chain before
releasing it, and never creates a thread or acquires a Modal worker. The
controller always reports whether the managed lane is idle, owned by a run,
disabled, or failed to check. Central T3 turns those states into explicit Limits
notices, so a process restart cannot make the configured subscription disappear.
Busy or failed refreshes retain any previously observed balance with its original
timestamp. Routing notices use the existing `probeFailed` wire shape and message,
so older web, desktop, and mobile clients can still decode the server config.
The controller caches successful model results
for five minutes, coalesces concurrent model requests, and retains the last
catalog during an outage. Model discovery still describes the shared API
execution catalog; the optional limits enrichment describes the configured
shared ChatGPT subscription.

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
Native-stream closure stops a hosted session without introducing an error;
the run driver owns interrupted-run failures. `ThreadErrorBanner` suppresses
the generic idle-expiry notice persisted by earlier versions so existing
threads also remain quiet while awaiting their next explicit restore action.

The controller publishes immutable checkpoint patches and file context; the
central server's `CompadreReview` adapter reads them without accessing Modal.
Web/desktop and mobile diff queries include the selected checkpoint revision in
their local cache identity. A later saved-review publication replaces an early
unavailable result without requiring a page reload; this revision is not sent
in the RPC payload. Hosted branch and working-tree views likewise follow the
latest checkpoint revision, since its saved review can arrive after the native
turn-completion event.

The hosted terminal direct transport adds `terminal.connection` to the shared
contract, `terminal/DirectTerminal.ts` to the worker HTTP routes and RPC handler,
and `state/directTerminal.ts` to client-runtime terminal atoms. The controller
terminal service brokers terminal-bound grants through the existing worker
lifecycle interface. See [Hosted worker terminals](hosted-worker-terminals.md).

## Upstream capabilities in hosted environments

When `COMPADRE_NATIVE_T3_URL` is configured, conversation and checkpoint rewind
commands are rejected. Active-thread reordering and question attachments are
unavailable: ordering needs canonical per-user persistence, and question files
need delivery through the controller to Modal. Capability descriptors and command
normalization enforce these boundaries for web, mobile, and direct API clients.

PR associations remain shared conversation data. Stacked PR operations are
unavailable until they execute in the owning Modal checkout. Automatic project
pulls are disabled both at startup and in background VCS refreshes on the central
server. Project execution defaults remain shared, with explicit overrides.

Manual compaction stays on the durable native provider-action path in hosted
mode. Local providers use upstream's in-process compaction implementation. The
controller continues to own remote replay and confirmation.

Usage page display preferences are stored per canonical signed-in user in browser
storage. They do not synchronize between browsers. Anonymous local environments
retain the upstream storage key.

The hosted sidebar omits project scope and project creation controls for the
single configured project. Search and new-thread creation remain available;
the identity filter has spacing above the search row. Participant photos, initials,
Slack thread links, and identity tabs live in `components/sidebar/CompadreSidebar.tsx`;
`SidebarChrome.tsx` owns the hosted operations navigation. Their rendered regression
tests run in web CI. The local E2E runbook's `check-sidebar.mjs` additionally checks
these components are wired into the actual authenticated hosted application; a
standalone local provider window does not exercise these hosted seams.

Hosted artifact-only assistant messages can follow the final answer. The chat
timeline keeps that last text answer visible when folding completed work, while
leaving later artifact messages visible.
