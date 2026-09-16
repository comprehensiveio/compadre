---
name: sync-compadre-upstream
description: Integrate upstream pingdotgg/t3code into comprehensiveio/compadre, review new features with the maintainer, replace overlapping custom implementations, and adapt persistence and user ownership. Use for an upstream T3 sync or integration rehearsal in Compadre.
---

# Sync Compadre upstream

Minimize Compadre's custom implementation while preserving agreed product
behavior, hosted execution, and multi-user ownership. Prefer upstream code when
it meets those requirements; deliberate divergence is not a reason to retain
an equivalent custom implementation.

## Establish the integration range

Follow the target repository's AGENTS.md and load its
`.agents/skills/change-compadre-stack/SKILL.md`. Use that skill's fork and
database guides for integration and its deployment guide only when relevant.
Resolve paths below relative to the Compadre checkout.

Inspect the current branch, dirty files, worktrees, remote URLs, and intended
base. Fetch upstream main and record the exact upstream and Compadre commits.
Use the merge base and upstream commit range for discovery, distinguishing
upstream changes from Compadre-only commits. Exclude vendored reference churn
from product summaries without ignoring dependency/toolchain compatibility.
Review actual changes, not just commit titles: features may have been reverted,
renamed, or already ported without their original ancestry.

Do not start a merge while the maintainer is still asking to discuss the
workflow. Prepare the concrete review first. Once integration is authorized,
use an isolated branch/worktree if the current checkout is shared or contains
other work. Preserve the reviewed upstream SHA if upstream advances mid-task.

## Review product choices together

Present a compact inventory with: upstream feature or changed behavior,
Compadre overlap (none/partial/full), take/adapt/defer recommendation, and the
required ownership, persistence, or execution changes. Link relevant source
files or upstream commits. Group routine fixes; separately identify new
capabilities, changed defaults, removed behavior, and settings migrations.
Explain user-visible behavior rather than listing commits.

Work through material choices with the maintainer before implementing them.
Honor choices already made; do not repeatedly ask for approval. Continue
independent analysis while a decision is pending. Unanswered choices are not
approval. If scope changes during integration, bring only the new product
decision back for discussion.

A normal merge brings code together; taking a feature means deciding whether
and how Compadre exposes it. For a deferred feature, explain whether upstream
code can remain dormant behind an existing capability boundary or needs a
narrow adaptation. Avoid a permanent cherry-pick queue or a second feature
implementation just to avoid integrating upstream history.

For overlap, compare contracts, historical state, failure behavior, and all
entry points. Prefer upstream internals and presentation; retain only necessary
hosting/identity adapters. Identify custom modules, branches, tests, or settings
that can actually be removed. Do not claim overlap is resolved from a similar
feature name or hide incompatible backend behavior by removing a button.

## Preserve upstream UX

Keep upstream presentation and interaction behavior unless the maintainer has
explicitly agreed to a product difference or a hosted ownership constraint
requires an adaptation. General performance or style guidance in upstream
AGENTS.md is not a reason to redesign the UX that upstream itself ships. Keep
upstream instructions largely intact; do not edit them to justify an integration
choice. Surface proposed UX differences during feature review.

For example, preserve upstream Thinking/tool activity shimmer and setup/compaction
feedback, including visibility pausing and reduced-motion safeguards. Do not
replace these with static labels merely because general guidance discourages
continuous repainting. A suspected performance issue needs measured evidence
and a reviewed change, rather than a silent merge resolution.

Audit the resulting client diff against the reviewed upstream revision for
removed feedback, animation classes, interaction handlers, and changed defaults.
Check clean merges as well as conflicts; distinguish necessary hosted adapters
and agreed product choices from incidental UX divergence, and restore the latter.

## Adapt data and execution ownership

Read `docs/internals/compadre-fork.md`,
`docs/internals/hosted-postgres-persistence.md`, and relevant implementation.
Hosted central T3 already uses PostgreSQL in `compadre_t3`; controller tables
remain in `public`. SQLite remains local/desktop/Modal persistence. Routine
syncs do not repeat the historical production SQLite import.

For each changed table, field, settings file, or persisted client value, decide:

- Owner: user, shared project/thread, organization, or environment.
- Authority: central conversation store, controller, or worker-local state.
- Existing-data default/backfill and reset/delete behavior.
- Read/write/subscription/cache behavior for two different authenticated users.

The agreed Compadre ownership defaults are personal sidebar organization and
display preferences per user, shared conversation content and PR associations,
and shared project execution defaults with explicit overrides. Apply these
without re-asking; discuss new ambiguous categories. Do not assume a field on
an upstream thread/project is already user-scoped, or turn shared
conversations private merely because Compadre is multi-user. Resolve actors
from authenticated canonical identity, not client-supplied user IDs. Keep
provider credentials and machine settings scoped to their real owners.

Inspect both migration registries before choosing IDs. Upstream and Compadre
can independently ship different migrations under the same numeric ID. Preserve
applied Compadre history; assign incoming work fresh ordered IDs and update
references/manifests/tests. Never silently replace a migration already applied
to local or restored worker data. If supporting direct upstream databases is
requested, design and test that history mapping explicitly.

Adapt every incoming SQLite schema/query change used by hosted code to Postgres,
including backfills, JSON, conflict handling, integer decoding, transaction
ordering, and projection replay. Update schema compatibility declarations and
parity manifests using the existing persistence workflow. Test fresh and
populated upgrades; a clean Git merge does not establish schema compatibility.

Follow remote operations through central server, controller, and Modal worker.
Git, files, terminals, previews, provider actions, usage, and restart recovery
must operate on the authoritative environment. Inspect
`docs/internals/hosted-provider-actions.md` for native action overlap. Upstream
in-process recovery is not proof of distributed recovery. Preserve immutable
native replay payloads and mixed-version operation across independently
deployed services and already-running/restored workers.

## Audit native events and agent tools

Compare added, removed, and changed orchestration events and payloads in
`packages/contracts/src/orchestration.ts` across the reviewed upstream range,
including clean merges. For each affected feature, trace the producer (provider,
MCP tool, reactor, or client command), its environment and thread identity,
`apps/server/src/compadre/NativeThreadEvents.ts`, the native-apply guard in the decider, persisted
projections, and client readers. A tool success or activity entry is not proof
that its state reached the canonical thread.

Classify each event as forwarded with identity translation, specially transformed,
or intentionally excluded with its authoritative owner and alternate path stated.
Preserve the mapper's exhaustive type check; never restore a catch-all discard to
make an integration compile. Reassess existing classifications when upstream changes
a payload or producer, even if its event name stays the same. Do not default new
shared conversation state to worker-local metadata.

Agent tools that read or mutate shared state must agree with browser commands in
both directions. PR associations, for example, are central-owned: verify hosted
link, unlink, and list tools all reach canonical central storage. Worker-local success or
a copied PR activity cannot establish that association. Follow the inverse action,
reads after browser edits, stacked/cross-repository links, and behavior after the
worker expires.

For each adapted flow, prove the durable central result with a focused worker/
central integration test, including applicable replay, fencing, and reverse-action
cases. Check PostgreSQL as well as worker SQLite where persistence is involved.
Review already-running workers, restored snapshots, and independently deployed
central/controller versions; unsupported combinations must fail explicitly, never
silently acknowledge lost state. List a feature as deferred if its hosted path is
not implemented, and gate its advertised capability accordingly.

## Choose integration and release boundaries

Default to one isolated integration branch targeting one fixed upstream commit
and one coherent integration PR when PR creation is authorized. Work and verify
incrementally within that branch, with meaningful commits where possible:
persistence compatibility, provider execution, then client behavior as their
dependencies permit. Finish each affected flow's focused verification as it
becomes runnable; do not defer all verification until the end.

Separate substantial, independently deliverable Compadre feature adaptations
into follow-up changes when the integration can preserve current behavior and
keep the new feature unavailable through a narrow capability boundary. Required
Postgres compatibility, data preservation, and existing functionality cannot
be deferred merely to shrink the integration PR. Deferred features must appear
in the final review with their remaining work; do not silently drop them or
claim the entire requested feature scope is complete.

Avoid arbitrary batches of upstream commits. Multiple integration releases are
appropriate only when intermediate upstream revisions provide coherent,
independently useful stopping points that can each be verified and deployed.
Reassess after merge rehearsal reveals actual conflicts and dependencies.

One integration PR does not imply one atomic deployment. Plan compatible
migration, controller, central web, and worker upgrade sequencing using the
stack deployment guide and the actual auto-deploy configuration. Account for
already-running workers and restored snapshots. If independent auto-deploys
cannot safely deliver a required sequence, split prerequisite compatibility
changes into separate releases. Code integration, feature enablement, and
production rollout are separate decisions; retain existing authorization
boundaries for each.

## Integrate and verify the agreed result

Use a normal `git merge upstream/main` (or the recorded reviewed commit), not
blanket ours/theirs resolution or routine cherry-picking. Resolve conflicts
around the agreed behavior. Audit cleanly merged fork seams too: semantic
regressions often produce no conflict. Preserve Compadre instructions and
deployment ownership rather than accepting upstream versions automatically.
In particular, audit new SQL functions in cleanly merged repositories against
the actual Postgres compatibility layer; an existing JSON extraction shim does
not imply support for other SQLite JSON functions. Check dependency upgrades
against Compadre-only modules that upstream cannot update or typecheck.

When upstream replaces a local feature, trace its new entry point through the
hosted adapter before removing the old path. In-process compaction, checkpointing,
and Git operations do not automatically implement durable remote equivalents.
For deferred features, pair capability flags with backend rejection; hiding a
button leaves older clients and direct API calls able to invoke it. Audit
background execution paths as well as startup and interactive entry points.

A clean merge can retain stale event filters, imports of newly private exports,
or duplicate test cases. Check these explicitly, especially where upstream has
added event variants or richer attachment types. Compare tests by observable
behavior rather than preserving obsolete markup expectations.

After dependency upgrades, verify scoped service lifetimes and transaction
identity in Compadre-only layers. A service returned from a closed test layer can
look like a production query bug; keep its resource scope alive for the operation.
Read/write SQL wrappers must share transaction context where nested operations
need atomicity. Serialize tests that intentionally use the same disposable
Postgres schema, or give them independent databases.

When shifting incoming migration numbers, update tests that stop at explicit migration IDs too. Keep inheritance tests independent of upstream default values when Compadre intentionally changes those defaults. Register standalone operator commands with upstream dead-code tooling and use the workspace test runner for new helper tests. Large integrations can exceed GitHub path-filter limits, so verify that controller CI actually starts even when its files fall beyond the first paths GitHub considers.

Run focused verification permitted by AGENTS.md. Cover changed backend behavior,
populated migration upgrades on SQLite and disposable Postgres, and user
separation where ownership changed. Test native action/replay and cross-service
contracts where affected. Check applicable entry points, clients, providers,
reverse actions, and connection modes. Do not run repo-wide checks, browsers,
or production mutations without the authorization required by the repository.

Before recommending merge/deployment after a substantial integration, use
`docs/operations/local-compadre-e2e.md` and `scripts/compadre-e2e.mjs` to bring up
the assembled product. The same tool is intended for ordinary Compadre updates.
Compose owns isolated Postgres, Temporal, and local S3; host processes run the
web/central server and controller, and real Modal runs the packaged integration.
Verify the archive fingerprint and both directions of service connectivity.
Use the runbook’s storage stop/start and terminal reconnect probes, plus its
resume command, rather than assuming a mounted object-store volume persists.
Exercise a production worker archive against the integration and a checkpointed
worker restore. Check final text remains visible when generated artifacts arrive.
Synthetic local identities exercise the normal session exchange but do not
establish Slack OIDC correctness. Local S3 does not prove production IAM or
worker access to object URLs. State these limits explicitly.

Require at least one real browser-to-Modal-to-persisted-browser turn, reload,
and applicable multi-user behavior before claiming end-to-end validation.
Expand to affected providers, attachments, compaction, terminal/reconnect, and
restart/restore boundaries. Test mixed running-worker versions for upstream
protocol changes. Keep browser/cloud authorization boundaries; when unavailable,
report the missing proof rather than replacing it with unit-test counts.

Update durable architecture or user documentation when behavior changes. Keep
the feature-review working notes outside the repository; don't commit a second
implementation checklist. Improve this skill with demonstrated lessons from
the real integration, avoiding incident-specific SHAs or migration numbers.

Present the integrated result: choices implemented/deferred, custom code removed,
necessary divergence retained with reasons, data/ownership adaptations, focused
verification evidence, and material untested surfaces. Distinguish a prepared
local integration from merged/deployed production. Create PRs, push, or deploy
only within the maintainer's authorization; this skill adds no such permission.
