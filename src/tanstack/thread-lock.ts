import {
  InMemoryLockStore,
  type LockStore,
} from "@tanstack/ai/locks";

export interface ThreadRunLease {
  signal: AbortSignal;
  release(): Promise<void>;
}

export class BackgroundCapacityPreemptedError extends Error {
  constructor() {
    super("Background capacity yielded to a waiting agent run");
    this.name = "BackgroundCapacityPreemptedError";
  }
}

/**
 * Adapt TanStack's critical-section lock to a streamed run whose lifetime ends
 * only after its AsyncIterable is drained.
 */
export class ThreadRunCoordinator {
  constructor(readonly locks: LockStore) {}

  async acquire(threadId: string): Promise<ThreadRunLease> {
    let resolveAcquired!: (signal: AbortSignal) => void;
    let rejectAcquired!: (error: unknown) => void;
    const acquired = new Promise<AbortSignal>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    let releaseCriticalSection!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });

    const holding = this.locks.withLock(
      `compadre-thread:${threadId}`,
      async (signal) => {
        resolveAcquired(signal);
        await released;
      }
    );
    void holding.catch(rejectAcquired);

    const signal = await acquired;
    let hasReleased = false;
    return {
      signal,
      async release() {
        if (hasReleased) return;
        hasReleased = true;
        releaseCriticalSection();
        await holding;
      },
    };
  }
}

export type BackgroundCapacityResult<T> =
  | { status: "completed"; value: T }
  | { status: "preempted" };

export type RunCapacityPriority = "foreground" | "background";

/**
 * Single-process capacity gate with foreground priority.
 *
 * Background work that already owns capacity is cooperatively cancelled as
 * soon as a user run arrives. The lease's AbortSignal reaches preparation
 * commands and harness processes so they can terminate their subprocess trees
 * before releasing capacity.
 */
export class RunCapacityCoordinator {
  private foregroundWaiters = 0;
  private backgroundAbortController: AbortController | undefined;

  constructor(private readonly coordinator: ThreadRunCoordinator) {}

  async acquireForeground(): Promise<ThreadRunLease> {
    this.foregroundWaiters += 1;
    this.backgroundAbortController?.abort(
      new BackgroundCapacityPreemptedError(),
    );
    try {
      return await this.coordinator.acquire("global");
    } finally {
      this.foregroundWaiters -= 1;
    }
  }

  async acquireBackground(): Promise<ThreadRunLease | undefined> {
    if (this.foregroundWaiters > 0) return undefined;

    const abortController = new AbortController();
    const lease = await this.coordinator.acquire("global");
    if (this.foregroundWaiters > 0) {
      await lease.release();
      return undefined;
    }

    this.backgroundAbortController = abortController;
    const abortForLostLease = () => abortController.abort(lease.signal.reason);
    lease.signal.addEventListener("abort", abortForLostLease, { once: true });
    let hasReleased = false;
    return {
      signal: abortController.signal,
      release: async () => {
        if (hasReleased) return;
        hasReleased = true;
        lease.signal.removeEventListener("abort", abortForLostLease);
        if (this.backgroundAbortController === abortController) {
          this.backgroundAbortController = undefined;
        }
        await lease.release();
      },
    };
  }

  async runBackground<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<BackgroundCapacityResult<T>> {
    const lease = await this.acquireBackground();
    if (!lease) return { status: "preempted" };
    try {
      const value = await task(lease.signal);
      return { status: "completed", value };
    } catch (error) {
      if (
        lease.signal.aborted &&
        lease.signal.reason instanceof BackgroundCapacityPreemptedError
      ) {
        return { status: "preempted" };
      }
      throw error;
    } finally {
      await lease.release();
    }
  }
}

export const harnessLockStore = new InMemoryLockStore();
export const harnessThreadRuns = new ThreadRunCoordinator(harnessLockStore);
/** Keep one coding harness active and let user work preempt background work. */
export const harnessRunCapacity = new RunCapacityCoordinator(
  new ThreadRunCoordinator(new InMemoryLockStore()),
);
