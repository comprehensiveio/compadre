import assert from "node:assert/strict";
import test from "node:test";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { superviseSandboxProvider } from "./supervised-provider.js";

test("reports spawned process roots without changing process behavior", async () => {
  const pids: number[] = [];
  const provider = superviseSandboxProvider(
    localProcessSandbox(),
    (pid) => pids.push(pid),
  );
  const handle = await provider.create({ id: "supervised-provider-test" });

  try {
    const child = await handle.process.spawn("printf supervised");
    let stdout = "";
    for await (const chunk of child.stdout) stdout += chunk;
    assert.equal(await child.wait(), 0);
    assert.equal(stdout, "supervised");
    assert.deepEqual(pids, [child.pid]);
  } finally {
    await handle.destroy();
  }
});
