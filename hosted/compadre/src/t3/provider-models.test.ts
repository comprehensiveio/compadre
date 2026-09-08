import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  discoverCodexModels,
  makeProviderModelDiscovery,
} from "./provider-models.js";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "./provider-versions.js";
import { providerCliUpgradeCommand } from "./modal-worker.js";

test("controller packages, image pins, and snapshot upgrades agree", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.dependencies["@openai/codex"], CODEX_VERSION);
  assert.equal(
    pkg.dependencies["@anthropic-ai/claude-code"],
    CLAUDE_CODE_VERSION,
  );
  const command = providerCliUpgradeCommand();
  assert.ok(command.includes(`@openai/codex@${CODEX_VERSION}`));
  assert.ok(
    command.includes(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`),
  );
});

test("native discovery paginates arbitrary models without sending a turn", async () => {
  const fixture = `
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const req = JSON.parse(line);
      if (req.method === "initialized") return;
      let result;
      if (req.method === "initialize") result = {};
      else if (req.method === "model/list") result = req.params.cursor
        ? { data: [{ model: "future-b", supportedReasoningEfforts: [{ reasoningEffort: "new-effort" }] }], nextCursor: null }
        : { data: [{ model: "future-a" }], nextCursor: "page-2" };
      else process.exit(2);
      console.log(JSON.stringify({ id: req.id, result }));
    });
  `;
  const result = await discoverCodexModels(
    { OPENAI_API_KEY: "test" },
    process.execPath,
    ["-e", fixture],
  );
  assert.deepEqual(
    result.data.map((model) => model.model),
    ["future-a", "future-b"],
  );
  assert.deepEqual(result.data[1]?.supportedReasoningEfforts, [
    { reasoningEffort: "new-effort" },
  ]);
});

test("native discovery rejects process failure", async () => {
  await assert.rejects(
    discoverCodexModels({ OPENAI_API_KEY: "test" }, process.execPath, [
      "-e",
      "process.exit(2)",
    ]),
    /exited/,
  );
});

test("catalog refresh coalesces callers and recovers after an outage", async () => {
  let calls = 0;
  let clock = 0;
  const discover = makeProviderModelDiscovery(
    async () => {
      calls++;
      if (calls === 2) throw new Error("offline");
      return {
        version: CODEX_VERSION,
        data: [{ model: `model-${calls}` }],
        nextCursor: null,
      };
    },
    () => clock,
  );
  const [first, concurrent] = await Promise.all([discover(), discover()]);
  assert.equal(calls, 1);
  assert.deepEqual(concurrent, first);
  clock += 300_001;
  assert.deepEqual(await discover(), first);
  clock += 30_001;
  assert.equal((await discover()).data[0]?.model, "model-3");
});

test("first discovery failure remains a failure rather than inventing models", async () => {
  const discover = makeProviderModelDiscovery(async () => {
    throw new Error("offline");
  });
  await assert.rejects(discover(), /offline/);
});
