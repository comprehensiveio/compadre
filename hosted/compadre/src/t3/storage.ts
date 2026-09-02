export interface MetadataStore {
  get(namespace: string, key: string): Promise<unknown | null>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
}

export interface LockStore {
  withLock<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/** Process-local serialization used only when no distributed store is injected. */
export class InMemoryLockStore implements LockStore {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation(new AbortController().signal);
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
