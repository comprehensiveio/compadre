import { AuthSessionId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AuthSessions from "./AuthSessions.ts";
import * as Pairing from "./AuthPairingLinks.ts";
import * as Runtime from "./ProviderSessionRuntime.ts";
import { RepositoryTestPersistence } from "./RepositoryTest.ts";

const persistence = Layer.mergeAll(AuthSessions.layer, Pairing.layer, Runtime.layer).pipe(
  Layer.provide(RepositoryTestPersistence),
);
const now = DateTime.makeUnsafe("2026-09-05T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-09-06T12:00:00.000Z");
it.effect(
  "round trips and revokes auth, consumes pairing once, and retains provider resume state",
  () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const pairing = yield* Pairing.AuthPairingLinkRepository;
      const runtime = yield* Runtime.ProviderSessionRuntimeRepository;
      const sessionId = AuthSessionId.make("contract-session");
      yield* sessions.create({
        sessionId,
        subject: "slack:user",
        scopes: ["orchestration:read"],
        method: "browser-session-cookie",
        client: {
          label: "Compadre",
          ipAddress: null,
          userAgent: null,
          deviceType: "desktop",
          os: null,
          browser: null,
        },
        issuedAt: now,
        expiresAt: later,
      });
      expect(Option.getOrThrow(yield* sessions.getById({ sessionId })).subject).toBe("slack:user");
      yield* pairing.create({
        id: "contract-pairing",
        credential: "contract-credential",
        method: "one-time-token",
        scopes: ["orchestration:read"],
        subject: "slack:user",
        label: null,
        proofKeyThumbprint: null,
        createdAt: now,
        expiresAt: later,
      });
      const results = yield* Effect.all(
        [1, 2].map(() =>
          pairing.consumeAvailable({
            credential: "contract-credential",
            proofKeyThumbprint: null,
            consumedAt: now,
            now,
          }),
        ),
        { concurrency: 2 },
      );
      expect(results.filter(Option.isSome)).toHaveLength(1);
      const row = {
        threadId: ThreadId.make("contract-thread"),
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        adapterKey: "compadre",
        runtimeMode: "full-access" as const,
        status: "running" as const,
        lastSeenAt: "2026-09-05T12:00:00.000Z",
        resumeCursor: { cursor: "雪:42" },
        runtimePayload: { actor: "slack:user", nullable: null },
      };
      yield* runtime.upsert(row);
      expect(Option.getOrThrow(yield* runtime.getByThreadId({ threadId: row.threadId }))).toEqual(
        row,
      );
      yield* sessions.revoke({ sessionId, revokedAt: now });
      expect(yield* sessions.listActive({ now })).toHaveLength(0);
      yield* runtime.deleteByThreadId({ threadId: row.threadId });
      expect(Option.isNone(yield* runtime.getByThreadId({ threadId: row.threadId }))).toBe(true);
    }).pipe(Effect.provide(persistence)),
);
