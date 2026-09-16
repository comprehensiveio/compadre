import { CommandId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { GitManager } from "../git/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** A Modal worker owns one thread's checkout, unlike a shared local project root. */
export const refreshHostedWorkerBranch = Effect.fn("refreshHostedWorkerBranch")(function* (
  snapshot: OrchestrationShellSnapshot,
  force = false,
) {
  if (!process.env.COMPADRE_CANONICAL_THREAD_ID?.trim() || snapshot.threads.length !== 1)
    return snapshot;
  const thread = snapshot.threads[0]!;
  const project = snapshot.projects.find((entry) => entry.id === thread.projectId);
  if (!project || thread.archivedAt !== null) return snapshot;
  const git = yield* GitManager;
  const cwd = thread.worktreePath ?? project.workspaceRoot;
  yield* git.invalidateLocalStatus(cwd);
  const local = yield* git.localStatus({ cwd });
  if (!local.isRepo || (!force && local.refName === thread.branch)) return snapshot;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.meta.update",
    commandId: CommandId.make(`compadre:checkout-branch:${yield* crypto.randomUUIDv4}`),
    threadId: thread.id,
    branch: local.refName,
    expectedBranch: thread.branch,
  });
  const snapshots = yield* ProjectionSnapshotQuery;
  return yield* snapshots.getShellSnapshot();
});
