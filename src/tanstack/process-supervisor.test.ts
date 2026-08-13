import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProcessMonitor,
  parseProcessTable,
  processTree,
} from "./process-supervisor.js";

test("parses safe process names and selects descendants", () => {
  const entries = parseProcessTable(`
    10 1 100 node
    11 10 200 sh
    12 11 300 pnpm
    20 1 400 unrelated
  `);

  assert.deepEqual(
    processTree(entries, new Set([10])).map((entry) => entry.pid),
    [10, 11, 12],
  );
  assert.equal(entries[2]!.rssBytes, 300 * 1024);
  assert.equal(entries[2]!.name, "pnpm");
});

test("reports process-tree and host memory without aborting under pressure", async () => {
  const samples: Array<{
    treeRssBytes: number;
    hostUsageBytes?: number;
    hostLimitBytes?: number;
  }> = [];
  const monitor = new AgentProcessMonitor({
    runId: "sample-run",
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 600, name: "node" },
      { pid: 11, ppid: 10, rssBytes: 500, name: "pnpm" },
    ],
    readHostMemory: async () => ({ usageBytes: 9_900, limitBytes: 10_000 }),
    onMemorySample: (sample) => {
      samples.push(sample);
    },
    logger: { log: () => undefined, warn: () => undefined },
  });

  monitor.trackRoot(10);
  await monitor.sample();

  assert.deepEqual(samples, [
    {
      treeRssBytes: 1_100,
      hostUsageBytes: 9_900,
      hostLimitBytes: 10_000,
    },
  ]);
  monitor.stop();
});

test("contains rejected memory observers", async () => {
  const warnings: string[] = [];
  const monitor = new AgentProcessMonitor({
    runId: "async-observer-run",
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 100, name: "node" },
    ],
    readHostMemory: async () => ({ usageBytes: 1_000, limitBytes: 10_000 }),
    onMemorySample: async () => {
      throw new Error("async telemetry unavailable");
    },
    logger: {
      log: () => undefined,
      warn: (message) => warnings.push(String(message)),
    },
  });

  monitor.trackRoot(10);
  await monitor.sample();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.match(warnings.join("\n"), /async telemetry unavailable/);
  monitor.stop();
});
