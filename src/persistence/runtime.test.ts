import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetConfiguredAgentRunDurabilityForTests } from "../durability/runtime.js";
import {
  getConfiguredThreadPersistence,
  getRequiredThreadPersistence,
  resetConfiguredThreadPersistenceForTests,
} from "./runtime.js";

const originalDurabilityBackend = process.env.COMPADRE_DURABILITY_BACKEND;

afterEach(() => {
  if (originalDurabilityBackend === undefined) {
    delete process.env.COMPADRE_DURABILITY_BACKEND;
  } else {
    process.env.COMPADRE_DURABILITY_BACKEND = originalDurabilityBackend;
  }
  resetConfiguredAgentRunDurabilityForTests();
  resetConfiguredThreadPersistenceForTests();
});

test("automatically configures thread persistence from durability", async () => {
  process.env.COMPADRE_DURABILITY_BACKEND = "memory";

  const runtime = await getConfiguredThreadPersistence();

  assert.ok(runtime);
  await runtime.persistence.stores.messages.saveThread("thread", [
    { role: "user", content: "persist me" },
  ]);
  assert.deepEqual(
    await runtime.persistence.stores.messages.loadThread("thread"),
    [{ role: "user", content: "persist me" }],
  );
});

test("fails clearly when a caller requires persistence without durability", async () => {
  delete process.env.COMPADRE_DURABILITY_BACKEND;

  await assert.rejects(
    getRequiredThreadPersistence(),
    /requires COMPADRE_DURABILITY_BACKEND=memory or postgres/,
  );
});
