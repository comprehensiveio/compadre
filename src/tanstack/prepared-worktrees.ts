import crypto from "node:crypto";
import {
  createWorktree,
  currentRepoRevision,
  prepareWorktree,
  removeWorktree,
  worktreeRevision,
} from "../repo.js";
import { PREPARED_WORKTREE_TARGET } from "../config.js";
import { harnessRunCapacity, type ThreadRunLease } from "./thread-lock.js";

export interface PreparedWorktree {
  id: string;
  path: string;
  revision: string;
}

export interface PreparedWorktreePoolDependencies {
  createId(): string;
  create(id: string): string;
  prepare(path: string): Promise<void>;
  remove(id: string): void;
  currentRevision(): string | undefined;
  revision(path: string): string | undefined;
  acquireCapacity(): Promise<ThreadRunLease>;
}

export interface PreparedWorktreePoolOptions {
  targetSize: number;
  refillDelayMs?: number;
  dependencies: PreparedWorktreePoolDependencies;
}

function boundedTargetSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(2, Math.floor(value)));
}

/**
 * Opportunistic cache of fully initialized, unowned worktrees.
 *
 * A claim permanently transfers ownership to the caller. Cache misses and all
 * preparation failures are intentionally non-fatal: the runtime creates and
 * prepares a normal worktree through its existing request path instead.
 */
export class PreparedWorktreePool {
  private readonly targetSize: number;
  private readonly refillDelayMs: number;
  private readonly dependencies: PreparedWorktreePoolDependencies;
  private readonly ready: PreparedWorktree[] = [];
  private refillPromise: Promise<void> | undefined;
  private refillTimer: NodeJS.Timeout | undefined;

  constructor({
    targetSize,
    refillDelayMs = 30_000,
    dependencies,
  }: PreparedWorktreePoolOptions) {
    this.targetSize = boundedTargetSize(targetSize);
    this.refillDelayMs = refillDelayMs;
    this.dependencies = dependencies;
  }

  /** IDs retained by the cache and therefore excluded from stale cleanup. */
  worktreeIds(): Set<string> {
    return new Set(this.ready.map((worktree) => worktree.id));
  }

  /**
   * Claim a current prepared worktree, discarding any whose base commit has
   * fallen behind the repository. Returns undefined on a normal cache miss.
   */
  claim(): PreparedWorktree | undefined {
    const currentRevision = this.dependencies.currentRevision();
    while (this.ready.length > 0) {
      const candidate = this.ready.shift()!;
      if (
        currentRevision !== undefined &&
        candidate.revision !== currentRevision
      ) {
        console.log(
          `[worktree-pool] discarding stale worktree=${candidate.id} prepared=${candidate.revision} current=${currentRevision}`,
        );
        this.dependencies.remove(candidate.id);
        continue;
      }

      console.log(
        `[worktree-pool] claimed worktree=${candidate.id} revision=${candidate.revision} ready=${this.ready.length}`,
      );
      return candidate;
    }
    return undefined;
  }

  /** Schedule a low-urgency refill so user runs have time to acquire capacity. */
  scheduleRefill(delayMs = this.refillDelayMs): void {
    if (
      this.targetSize === 0 ||
      this.ready.length >= this.targetSize ||
      this.refillPromise ||
      this.refillTimer
    ) {
      return;
    }

    this.refillTimer = setTimeout(() => {
      this.refillTimer = undefined;
      void this.refill().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[worktree-pool] scheduled refill failed: ${message}`);
      });
    }, Math.max(0, delayMs));
    this.refillTimer.unref();
  }

  /** Fill the cache serially. Calls coalesce into one in-flight operation. */
  refill(): Promise<void> {
    if (this.targetSize === 0 || this.ready.length >= this.targetSize) {
      return Promise.resolve();
    }
    if (this.refillPromise) return this.refillPromise;

    this.refillPromise = this.fill().finally(() => {
      this.refillPromise = undefined;
    });
    return this.refillPromise;
  }

  /** Remove cached worktrees that no longer match the refreshed repository. */
  reconcile(): void {
    const currentRevision = this.dependencies.currentRevision();
    if (currentRevision === undefined) return;

    const stale = this.ready.filter(
      (worktree) => worktree.revision !== currentRevision,
    );
    if (stale.length === 0) return;

    const staleIds = new Set(stale.map((worktree) => worktree.id));
    for (let index = this.ready.length - 1; index >= 0; index -= 1) {
      if (staleIds.has(this.ready[index]!.id)) this.ready.splice(index, 1);
    }
    for (const worktree of stale) {
      console.log(
        `[worktree-pool] invalidating worktree=${worktree.id} after repo refresh`,
      );
      this.dependencies.remove(worktree.id);
    }
  }

  private async fill(): Promise<void> {
    while (this.ready.length < this.targetSize) {
      const lease = await this.dependencies.acquireCapacity();
      const id = this.dependencies.createId();
      const startedAt = Date.now();
      let path: string | undefined;
      try {
        // Re-check after acquiring capacity: another refill may have completed
        // while this low-priority job was waiting behind an agent run.
        if (this.ready.length >= this.targetSize) return;

        path = this.dependencies.create(id);
        await this.dependencies.prepare(path);
        const revision = this.dependencies.revision(path);
        const currentRevision = this.dependencies.currentRevision();
        if (
          revision === undefined ||
          (currentRevision !== undefined && revision !== currentRevision)
        ) {
          throw new Error(
            `prepared revision ${revision ?? "unknown"} does not match current ${currentRevision ?? "unknown"}`,
          );
        }

        this.ready.push({ id, path, revision });
        console.log(
          `[worktree-pool] ready worktree=${id} revision=${revision} duration=${Date.now() - startedAt}ms ready=${this.ready.length}`,
        );
      } catch (error) {
        if (path !== undefined) this.dependencies.remove(id);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[worktree-pool] preparation failed worktree=${id} duration=${Date.now() - startedAt}ms: ${message}`,
        );
        // Fail open and wait for a later scheduled/maintenance refill rather
        // than spinning on a broken repository or setup script.
        return;
      } finally {
        await lease.release();
      }
    }
  }
}

export const harnessPreparedWorktrees = new PreparedWorktreePool({
  targetSize: PREPARED_WORKTREE_TARGET,
  dependencies: {
    createId: () => crypto.randomUUID(),
    create: createWorktree,
    prepare: prepareWorktree,
    remove: removeWorktree,
    currentRevision: currentRepoRevision,
    revision: worktreeRevision,
    acquireCapacity: () => harnessRunCapacity.acquire("global"),
  },
});
