# Comprehensive's T3 fork

This repository is an intentional product fork of T3 Code. Comprehensive uses
the native T3 server, web application, Codex provider, and Claude Code provider
as the conversation system for Compadre. Compadre routes provider execution to
one isolated Modal environment per thread and exposes Slack and HTTP as equal
entrypoints to the same central T3 conversation.

The companion Compadre controller repository owns the canonical cross-stack
change guide at `.agents/skills/change-compadre-stack/SKILL.md`. Load it before
changing a Compadre seam, database, deployment, or production flow. If a T3
change makes that guide verifiably inaccurate, update it in a paired controller
change; do not duplicate the guide in this repository.

The fork should be capable of meaningful product changes while remaining cheap
to update from `pingdotgg/t3code`. The rule is not “never change upstream code.”
It is “concentrate each product difference behind a narrow seam.”

## Fork seams

| Seam | Comprehensive implementation | Upstream surface changed |
| --- | --- | --- |
| Remote native execution | `apps/server/src/provider/RemoteNativeProvider.ts` and the `Compadre*` provider layers | Provider registry wiring only |
| Controller text generation | `apps/server/src/textGeneration/CompadreTextGeneration.ts` | Remote provider construction only |
| Runtime telemetry | `apps/server/src/provider/ProviderRuntimeTelemetry.ts` | Provider event observation hooks |
| Protocol durability | Cursor-aware reconnect in `apps/server/src/provider/Layers/CompadreTransport.ts` | No UI or storage changes |
| Hosted authentication | `apps/server/src/auth/CompadreAuth.ts` and `CompadrePreviewGateway.ts` | Server route/session composition |
| Controller MCP bridge | `apps/server/src/mcp/CompadreMcpBridge.ts` | Codex and Claude adapter hooks |
| Hosted backup | `apps/server/src/auth/CompadreBackup.ts` | Server route composition |
| Message attribution | migrations `043` and `044` plus command attribution hooks | Contracts, projection, and UI |
| Compadre product UI | branding, session, sidebar, chat, usage, and CSS hooks in `apps/web` | Narrow components and styles |

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

Central T3 SQLite owns the canonical conversation, message attribution,
participants, usage projection, and browser sessions rendered by the hosted
UI. The Compadre controller's Postgres owns canonical users and Slack
identities, external-thread bindings, run/event delivery, worker identity,
leases, recovery metadata, and the Slack delivery outbox. Browser
authentication is exchanged through the controller and materialized as a T3
session; client-supplied display names are never authorization data.

The controller and T3 fork auto-deploy independently. Cross-repository
contracts must remain backward compatible through the rollout, and the
cross-stack skill defines the safe deployment order and live verification
requirements.
