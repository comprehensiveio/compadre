import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeFairDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeFairDrainableWorker", () => {
  it.live("takes turns between keys while preserving each key's order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeFairDrainableWorker({
          key: (item: { readonly key: string; readonly value: string }) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              processed.push(`${item.key}:${item.value}`);
              if (item.value === "a1") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue({ key: "a", value: "a1" });
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue({ key: "a", value: "a2" });
        yield* worker.enqueue({ key: "a", value: "a3" });
        yield* worker.enqueue({ key: "b", value: "b1" });
        yield* worker.enqueue({ key: "b", value: "b2" });
        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["a:a1", "b:b1", "a:a2", "b:b2", "a:a3"]);
      }),
    ),
  );
});
