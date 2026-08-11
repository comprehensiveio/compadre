import {
  InMemoryLockStore,
  type LockStore,
} from "@tanstack/ai/locks";

export interface ThreadRunLease {
  signal: AbortSignal;
  release(): Promise<void>;
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

export const harnessLockStore = new InMemoryLockStore();
export const harnessThreadRuns = new ThreadRunCoordinator(harnessLockStore);
/** The 2 GiB service can safely host only one coding harness process tree. */
export const harnessRunCapacity = new ThreadRunCoordinator(
  new InMemoryLockStore(),
);
