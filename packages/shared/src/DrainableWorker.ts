/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

interface FairDrainableWorkerState<K, A> {
  readonly pendingByKey: Map<K, FairPendingQueue<A>>;
  readonly scheduledKeys: Set<K>;
  readonly outstanding: number;
}

interface FairQueueNode<A> {
  readonly value: A;
  readonly next: FairQueueNode<A> | undefined;
}

interface FairPendingQueue<A> {
  readonly front: FairQueueNode<A> | undefined;
  readonly back: FairQueueNode<A> | undefined;
}

function reverseFairQueue<A>(node: FairQueueNode<A> | undefined): FairQueueNode<A> | undefined {
  let current = node;
  let reversed: FairQueueNode<A> | undefined;
  while (current !== undefined) {
    reversed = { value: current.value, next: reversed };
    current = current.next;
  }
  return reversed;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create a drainable worker that processes one item per key before moving the
 * key to the back of the queue. Items for the same key keep their input order.
 */
export const makeFairDrainableWorker = <A, K, E, R>(options: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<FairDrainableWorkerState<K, A>>({
      pendingByKey: new Map(),
      scheduledKeys: new Set(),
      outstanding: 0,
    });

    const takeNext = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const pending = state.pendingByKey.get(key);
        if (pending === undefined) {
          const scheduledKeys = new Set(state.scheduledKeys);
          scheduledKeys.delete(key);
          return [null, { ...state, scheduledKeys }] as const;
        }

        const front = pending.front ?? reverseFairQueue(pending.back);
        if (front === undefined) {
          const pendingByKey = new Map(state.pendingByKey);
          pendingByKey.delete(key);
          const scheduledKeys = new Set(state.scheduledKeys);
          scheduledKeys.delete(key);
          return [null, { ...state, pendingByKey, scheduledKeys }] as const;
        }

        const pendingByKey = new Map(state.pendingByKey);
        const next = {
          front: front.next,
          back: pending.front === undefined ? undefined : pending.back,
        };
        if (next.front === undefined && next.back === undefined) {
          pendingByKey.delete(key);
        } else {
          pendingByKey.set(key, next);
        }
        return [{ key, item: front.value } as const, { ...state, pendingByKey }] as const;
      }).pipe(Effect.tx);

    const finishKey = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const outstanding = state.outstanding - 1;
        const pending = state.pendingByKey.get(key);
        if (pending !== undefined) {
          return [true, { ...state, outstanding }] as const;
        }

        const scheduledKeys = new Set(state.scheduledKeys);
        scheduledKeys.delete(key);
        return [false, { ...state, scheduledKeys, outstanding }] as const;
      }).pipe(
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(queue, key) : Effect.void,
        ),
        Effect.tx,
      );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap(takeNext),
      Effect.flatMap((next) =>
        next === null
          ? Effect.void
          : Effect.ensuring(options.process(next.item), finishKey(next.key)),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (item) => {
      const key = options.key(item);
      return TxRef.modify(stateRef, (state) => {
        const pendingByKey = new Map(state.pendingByKey);
        const pending = pendingByKey.get(key);
        pendingByKey.set(key, {
          front: pending?.front,
          back: { value: item, next: pending?.back },
        });

        if (state.scheduledKeys.has(key)) {
          return [false, { ...state, pendingByKey, outstanding: state.outstanding + 1 }] as const;
        }

        const scheduledKeys = new Set(state.scheduledKeys);
        scheduledKeys.add(key);
        return [
          true,
          { ...state, pendingByKey, scheduledKeys, outstanding: state.outstanding + 1 },
        ] as const;
      }).pipe(
        Effect.flatMap((shouldSchedule) =>
          shouldSchedule ? TxQueue.offer(queue, key) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );
    };

    const drain: DrainableWorker<A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
