import assert from "node:assert/strict";
import test from "node:test";
import { CodexSubscriptionLane } from "./codex-subscription-lane.js";
import { InMemoryLockStore, type MetadataStore } from "./storage.js";

function memoryMetadata() {
  const values = new Map<string, unknown>();
  const store: MetadataStore = {
    async get(namespace, key) {
      return values.get(`${namespace}:${key}`) ?? null;
    },
    async set(namespace, key, value) {
      values.set(`${namespace}:${key}`, value);
    },
    async delete(namespace, key) {
      values.delete(`${namespace}:${key}`);
    },
  };
  return { store, values };
}

function environment(refreshToken = "seed-refresh-token"): NodeJS.ProcessEnv {
  return {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "true",
    COMPADRE_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CODEX_AUTH_JSON_BASE64: Buffer.from(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: refreshToken },
      }),
    ).toString("base64"),
  };
}

test("absent experiment configuration needs no secrets and preserves legacy mode", async () => {
  const { store, values } = memoryMetadata();
  const lane = new CodexSubscriptionLane(store, new InMemoryLockStore(), {});

  assert.deepEqual(
    await lane.claim({ canonicalThreadId: "thread-a", runId: "run-a" }),
    { route: "api", requiresConfiguration: false },
  );
  assert.equal(values.size, 0);
});

test("explicit kill switch routes warm workers back to API", async () => {
  const { store } = memoryMetadata();
  const lane = new CodexSubscriptionLane(store, new InMemoryLockStore(), {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "false",
  });

  assert.equal(lane.managed, true);
  assert.deepEqual(
    await lane.claim({ canonicalThreadId: "thread-a", runId: "run-a" }),
    { route: "api", requiresConfiguration: true },
  );
});

test("parallel threads allocate exactly one subscription route", async () => {
  const { store } = memoryMetadata();
  const lane = new CodexSubscriptionLane(
    store,
    new InMemoryLockStore(),
    environment(),
  );

  const claims = await Promise.all([
    lane.claim({ canonicalThreadId: "thread-a", runId: "run-a" }),
    lane.claim({ canonicalThreadId: "thread-b", runId: "run-b" }),
  ]);

  assert.deepEqual(claims.map((claim) => claim.route).sort(), [
    "api",
    "subscription",
  ]);
});

test("steers retain the thread route and stale finalizers cannot release it", async () => {
  const { store } = memoryMetadata();
  const lane = new CodexSubscriptionLane(
    store,
    new InMemoryLockStore(),
    environment(),
  );
  await lane.claim({ canonicalThreadId: "thread-a", runId: "run-old" });

  const steer = await lane.claim({
    canonicalThreadId: "thread-a",
    runId: "run-new",
  });
  const staleRelease = await lane.release({
    canonicalThreadId: "thread-a",
    runId: "run-old",
    refreshedAuthJson: JSON.stringify({ auth_mode: "chatgpt" }),
  });

  assert.equal(steer.route, "subscription");
  assert.equal(steer.requiresConfiguration, false);
  assert.equal(staleRelease, false);
  assert.equal(
    await lane.routeForRun({
      canonicalThreadId: "thread-a",
      runId: "run-old",
    }),
    undefined,
  );
  assert.equal(await lane.routeForThread("thread-a"), "subscription");
});

test("persisted subscription auth is encrypted and refreshed before handoff", async () => {
  const { store, values } = memoryMetadata();
  const lane = new CodexSubscriptionLane(
    store,
    new InMemoryLockStore(),
    environment(),
  );
  await lane.claim({ canonicalThreadId: "thread-a", runId: "run-a" });
  const persisted = JSON.stringify([...values.values()]);
  assert.doesNotMatch(persisted, /seed-refresh-token/);

  const refreshed = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refreshed-token" },
  });
  assert.equal(
    await lane.release({
      canonicalThreadId: "thread-a",
      runId: "run-a",
      refreshedAuthJson: refreshed,
    }),
    true,
  );
  const next = await lane.claim({
    canonicalThreadId: "thread-b",
    runId: "run-b",
  });
  assert.equal(next.route, "subscription");
  assert.equal(next.authJson, refreshed);
  assert.doesNotMatch(JSON.stringify([...values.values()]), /refreshed-token/);
});

test("API-routed steers stay on API until their latest run finishes", async () => {
  const { store } = memoryMetadata();
  const lane = new CodexSubscriptionLane(
    store,
    new InMemoryLockStore(),
    environment(),
  );
  await lane.claim({ canonicalThreadId: "subscription", runId: "sub-run" });
  await lane.claim({ canonicalThreadId: "api", runId: "api-old" });

  const steer = await lane.claim({
    canonicalThreadId: "api",
    runId: "api-new",
  });
  assert.equal(steer.route, "api");
  assert.equal(
    await lane.release({ canonicalThreadId: "api", runId: "api-old" }),
    false,
  );
  assert.equal(await lane.routeForThread("api"), "api");
  assert.equal(
    await lane.release({ canonicalThreadId: "api", runId: "api-new" }),
    true,
  );
});

test("enabled lane validates both bootstrap auth and encryption key", () => {
  const { store } = memoryMetadata();
  assert.throws(
    () =>
      new CodexSubscriptionLane(store, new InMemoryLockStore(), {
        COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "true",
      }),
    /ENCRYPTION_KEY is required/,
  );
  assert.throws(
    () =>
      new CodexSubscriptionLane(store, new InMemoryLockStore(), {
        ...environment(),
        COMPADRE_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64"),
      }),
    /decode to 32 bytes/,
  );
});
