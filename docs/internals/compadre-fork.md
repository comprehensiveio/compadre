# Comprehensive's T3 fork

This repository is an intentional product fork of T3 Code. Comprehensive uses
the native T3 server, web application, Codex provider, and Claude Code provider
as the conversation system for Compadre. Compadre routes provider execution to
one isolated Modal environment per thread and exposes Slack and HTTP as equal
entrypoints to the same central T3 conversation.

The fork should be capable of meaningful product changes while remaining cheap
to update from `pingdotgg/t3code`. The rule is not “never change upstream code.”
It is “concentrate each product difference behind a narrow seam.”

## Fork seams

| Seam                       | Comprehensive implementation                                            | Upstream surface changed          |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Remote native execution    | `RemoteNativeProvider.ts`, `CompadreAdapter.ts`, `CompadreTransport.ts` | Provider registry wiring only     |
| Controller text generation | `CompadreTextGeneration.ts`                                             | Remote provider construction only |
| Runtime telemetry          | `ProviderRuntimeTelemetry.ts`                                           | Provider event observation hooks  |
| Protocol durability        | Cursor-aware reconnect inside `CompadreTransport.ts`                    | No UI or storage changes          |

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

## Intended direction

Future work includes small UI changes and first-class users/message actors,
probably established through Slack authentication. Central T3 remains the
owner of conversation and actor data. Compadre Postgres owns execution leases,
external-thread bindings, delivery cursors, and recovery metadata.
