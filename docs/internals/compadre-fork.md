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
the single event reader, reuses the current orchestration turn id, and drains
a second controller request only to queue the new input into the thread-scoped
Modal T3 session. This matches T3's native Claude/Codex adapters: the provider
loop decides when to incorporate the steer, without Compadre cancelling or
synthetically ending the active turn. Controller-side Slack delivery assigns
the final response to the newest user message so older delivery requests
settle quietly rather than surfacing an interruption or duplicate.

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
repository contracts on both backends. Do not copy Tolty or upstream migrations
without comparing Compadre’s attribution/participants and authentication fields.
The parity test intentionally fails when the SQLite migration tip changes. Keep
runtime persistence selection dynamic and server composition hooks additive.
