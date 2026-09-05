# Hosted workspace reviews

Hosted Compadre publishes workspace reviews at turn completion. The Modal
checkout owns Git; the central web server owns the conversation and the saved
review reference. Opening a diff never provisions, reconnects to, or restores a
worker.

The controller's existing native-run completion hook waits for the dispatched
message's ready checkpoint, reconnects to the current worker, and captures
immutable Git objects. It saves four comparisons: the individual turn, changes
since thread start, the branch against the merge base of main/master, and HEAD
against the completed checkpoint. Branch and working-tree views are snapshots
at completion, not live filesystem views. The initial checkpoint is the fallback
branch base when main/master is unavailable. Arbitrary base selection and
checkpoint restore are unavailable for saved reviews; users can request an undo
in a new agent turn.

`workspace-review-capture.ts` runs a bounded Python exporter on the existing
worker. The controller uploads deduplicated SHA-256 text blobs before a version
1 JSON manifest through `T3ArtifactStore`, using the existing private encrypted
artifact bucket. A `workspace-review:` storage scope prevents identical source
text from overwriting user-facing output-artifact metadata. Source text is in object storage, not the conversation database.
A small publication record in controller metadata namespace
`compadre.t3.workspace-reviews.v1` associates the run and canonical thread with
its immutable manifest. Delivery retries reuse that publication. Concurrent
attempts may leave additional immutable objects for the same run; thread
ownership applies to all of them.

Only after publication succeeds does `WORKSPACE_REVIEW` enter the durable run
stream, before `RUN_FINISHED`. The central Compadre provider adapter and runtime
ingestion turn this into a ready checkpoint with a
`compadre-review:<run-id>:<sha256>` reference and file summaries. Both Codex and
Claude use this transport. Central checkpoint capture is disabled in hosted
transport mode because its filesystem is not the worker's workspace.

`CompadreReview` serves the existing review RPCs from central checkpoint metadata
and authenticated controller `POST /hosted/t3/review` requests. The controller
validates canonical thread ownership and reads only stored objects. File-context
requests must match a path and comparison in the manifest. Snapshot references
keep expansion tied to the patch displayed even when another turn finishes.
Local environments retain their Git-backed review service. The web and desktop
web shell use the same renderer; mobile can consume the additive contracts but
has no new saved-review UI in this change.

## Limits and failure behavior

Each comparison includes at most 1,000 changed files and 2 MiB of combined normal
and whitespace-ignored patches. The capture stores at most 20 MiB of distinct
text context, with a 1 MiB limit per file. Binary, non-UTF-8, submodule, and
oversized context is explicitly unavailable. Whole patches are omitted when a
budget is exceeded, and the response is marked truncated. A capture has a
110-second worker deadline and a 120-second controller request deadline.

An unavailable checkpoint, worker, or object store produces a runtime warning;
it does not turn a successful provider response into a failed turn. Previously
published reviews remain readable. Threads predating this feature have no saved
review until a new turn publishes one. Reads never try to reconstruct a missing
review by starting a worker. Failed captures are not backfilled automatically.

Review objects currently follow output-artifact retention: there is no automatic
expiry or garbage collection in this feature. Any future retention cleanup must
coordinate manifests, blobs, publication metadata, and canonical checkpoint
references. Do not apply a bucket expiry rule without making expired snapshots
explicitly unavailable in the client.

## Rollout and verification

The controller publishes only when `COMPADRE_T3_WORKSPACE_REVIEWS_ENABLED=true`.
Deploy both services with publication disabled, verify the central consumer is
live, then enable publication on the controller. The wire
fields and stream event are additive; an older controller simply produces no
saved review. An older central consumer ignores the new event, so deploy order
avoids silently losing checkpoint summaries during rollout. No database
migration, tunnel, or new bucket is required. The controller needs the existing
`COMPADRE_T3_ARTIFACT_BUCKET` and region configuration.

Run the focused exporter/storage, client checkpoint-wait, native-driver,
provider-ingestion, and review RPC tests. The exporter/storage test captures real
Git commits, deletes the checkout, and exercises the authenticated controller
route and expandable contents with a gateway that throws if accessed. Verify
production with a fresh small file edit, the central ready checkpoint, the
publication record, a browser reload and context expansion, and no worker
activity caused by those reads. Verify both providers before claiming parity.
