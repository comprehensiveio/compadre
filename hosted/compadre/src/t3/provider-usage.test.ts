import assert from "node:assert/strict";
import test from "node:test";
import { CodexSubscriptionLane } from "./codex-subscription-lane.js";
import { discoverCodexSubscriptionUsage } from "./provider-usage.js";
import { InMemoryLockStore, type MetadataStore } from "./storage.js";

test("subscription usage reads account limits and preserves refreshed auth", async () => {
  const values = new Map<string, unknown>();
  const metadata: MetadataStore = {
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
  const lane = new CodexSubscriptionLane(metadata, new InMemoryLockStore(), {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "true",
    COMPADRE_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    CODEX_AUTH_JSON_BASE64: Buffer.from(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "seed" },
      }),
    ).toString("base64"),
  });
  const fixture = `
    const fs = require("node:fs");
    const path = require("node:path");
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const req = JSON.parse(line);
      if (req.method === "initialized") return;
      let result;
      if (req.method === "initialize") result = {};
      else if (req.method === "account/read") result = { account: { type: "chatgpt", email: "codex@example.com", planType: "pro" }, requiresOpenaiAuth: false };
      else if (req.method === "account/rateLimits/read") {
        result = { rateLimits: { limitId: "codex", primary: { usedPercent: 31, windowDurationMins: 300 } } };
        fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refreshed" } }));
      } else process.exit(2);
      console.log(JSON.stringify({ id: req.id, result }));
    });
  `;

  const result = await discoverCodexSubscriptionUsage(lane, process.execPath, [
    "-e",
    fixture,
  ]);
  assert.equal(result.subscription.status, "idle");
  if (!("account" in result)) assert.fail("expected an idle subscription lane");
  assert.equal(
    (result.account as { account?: { planType?: string } }).account?.planType,
    "pro",
  );
  assert.equal(
    (
      result.rateLimits as {
        rateLimits?: { primary?: { usedPercent?: number } };
      }
    ).rateLimits?.primary?.usedPercent,
    31,
  );
  const claim = await lane.claim({
    canonicalThreadId: "thread-a",
    runId: "run-a",
  });
  assert.match(claim.authJson ?? "", /refreshed/);
});

test("subscription usage reports lane availability without probing owned or disabled lanes", async () => {
  const values = new Map<string, unknown>();
  const metadata: MetadataStore = {
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
  const enabled = new CodexSubscriptionLane(metadata, new InMemoryLockStore(), {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "true",
    COMPADRE_CODEX_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    CODEX_AUTH_JSON_BASE64: Buffer.from(
      JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "seed" } }),
    ).toString("base64"),
  });
  await enabled.claim({ canonicalThreadId: "thread-a", runId: "run-a" });
  assert.deepEqual(
    await discoverCodexSubscriptionUsage(enabled, "must-not-spawn"),
    { subscription: { status: "busy" } },
  );

  const disabled = new CodexSubscriptionLane(metadata, new InMemoryLockStore(), {
    COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED: "false",
  });
  assert.deepEqual(
    await discoverCodexSubscriptionUsage(disabled, "must-not-spawn"),
    { subscription: { status: "disabled" } },
  );
});
