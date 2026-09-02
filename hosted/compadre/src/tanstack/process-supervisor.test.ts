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

test("logs process-tree and cgroup memory pressure", async () => {
  const messages: string[] = [];
  const monitor = new AgentProcessMonitor({
    runId: "pressure-run",
    sampleIntervalMs: 60_000,
    logIntervalMs: 0,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 25 * 1024 * 1024, name: "node" },
      { pid: 11, ppid: 10, rssBytes: 75 * 1024 * 1024, name: "codex" },
    ],
    readHostMemory: async () => ({
      usageBytes: 3 * 1024 * 1024 * 1024,
      limitBytes: 4 * 1024 * 1024 * 1024,
    }),
    logger: {
      log: (message) => messages.push(String(message)),
      warn: () => undefined,
    },
  });

  monitor.trackRoot(10);
  await monitor.sample();
  monitor.stop();

  assert.match(messages.join("\n"), /tree-rss-mib=100/);
  assert.match(messages.join("\n"), /cgroup-mib=3072/);
  assert.match(messages.join("\n"), /cgroup-limit-mib=4096/);
  assert.match(messages.join("\n"), /cgroup-percent=75\.0/);
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
