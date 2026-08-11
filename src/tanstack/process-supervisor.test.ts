import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import {
  AgentProcessSupervisor,
  DEFAULT_AGENT_TREE_MEMORY_MB,
  DEFAULT_CGROUP_MEMORY_HEADROOM_MB,
  configuredAgentMemoryLimits,
  parseProcessTable,
  processTree,
} from "./process-supervisor.js";

test("configures conservative default memory limits with environment overrides", () => {
  assert.deepEqual(configuredAgentMemoryLimits({}), {
    treeLimitBytes: DEFAULT_AGENT_TREE_MEMORY_MB * 1024 * 1024,
    cgroupHeadroomBytes: DEFAULT_CGROUP_MEMORY_HEADROOM_MB * 1024 * 1024,
  });
  assert.deepEqual(
    configuredAgentMemoryLimits({
      COMPADRE_AGENT_TREE_MEMORY_MB: "2048",
      COMPADRE_CGROUP_MEMORY_HEADROOM_MB: "512",
    }),
    {
      treeLimitBytes: 2_048 * 1024 * 1024,
      cgroupHeadroomBytes: 512 * 1024 * 1024,
    },
  );
});

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function trippedCgroupSupervisor(): Promise<AgentProcessSupervisor> {
  const supervisor = new AgentProcessSupervisor({
    runId: "cgroup-run",
    abortController: new AbortController(),
    treeLimitBytes: 10_000,
    cgroupHeadroomBytes: 1_000,
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 100, name: "claude" },
    ],
    readHostMemory: async () => ({ usageBytes: 9_500, limitBytes: 10_000 }),
    logger: { log: () => undefined, warn: () => undefined },
  });
  supervisor.trackRoot(10);
  await supervisor.sample();
  return supervisor;
}

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

test("aborts a run when its process tree exceeds the configured limit", async () => {
  const abortController = new AbortController();
  const warnings: string[] = [];
  const supervisor = new AgentProcessSupervisor({
    runId: "memory-run",
    abortController,
    treeLimitBytes: 1_000,
    cgroupHeadroomBytes: 500,
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 600, name: "node" },
      { pid: 11, ppid: 10, rssBytes: 500, name: "pnpm" },
    ],
    readHostMemory: async () => ({ usageBytes: 2_000, limitBytes: 10_000 }),
    onMemorySample: () => {
      throw new Error("telemetry unavailable");
    },
    logger: {
      log: () => undefined,
      warn: (message) => warnings.push(String(message)),
    },
  });

  supervisor.trackRoot(10);
  await supervisor.sample();

  assert.equal(abortController.signal.aborted, true);
  assert.equal(supervisor.limitError?.reason, "process-tree");
  assert.match(warnings.join("\n"), /10:node/);
  assert.match(warnings.join("\n"), /memory observer failed/);
  supervisor.stop();
});

test("caps the process-tree limit to the observed cgroup capacity", async () => {
  const supervisor = new AgentProcessSupervisor({
    runId: "small-cgroup-run",
    abortController: new AbortController(),
    treeLimitBytes: 10_000,
    cgroupHeadroomBytes: 1_000,
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 7_500, name: "node" },
    ],
    readHostMemory: async () => ({ usageBytes: 2_000, limitBytes: 8_000 }),
    logger: { log: () => undefined, warn: () => undefined },
  });

  supervisor.trackRoot(10);
  await supervisor.sample();

  assert.equal(supervisor.limitError?.reason, "process-tree");
  assert.equal(supervisor.limitError?.limitBytes, 7_000);
  supervisor.stop();
});

test("contains rejected async memory observers", async () => {
  const warnings: string[] = [];
  const supervisor = new AgentProcessSupervisor({
    runId: "async-observer-run",
    abortController: new AbortController(),
    treeLimitBytes: 10_000,
    cgroupHeadroomBytes: 1_000,
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

  supervisor.trackRoot(10);
  await supervisor.sample();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.match(warnings.join("\n"), /async telemetry unavailable/);
  supervisor.stop();
});

test("reports process-tree and host memory samples", async () => {
  const samples: Array<{
    treeRssBytes: number;
    hostUsageBytes?: number;
    hostLimitBytes?: number;
  }> = [];
  const supervisor = new AgentProcessSupervisor({
    runId: "sample-run",
    abortController: new AbortController(),
    treeLimitBytes: 10_000,
    cgroupHeadroomBytes: 1_000,
    sampleIntervalMs: 60_000,
    readProcesses: async () => [
      { pid: 10, ppid: 1, rssBytes: 600, name: "node" },
      { pid: 11, ppid: 10, rssBytes: 500, name: "pnpm" },
    ],
    readHostMemory: async () => ({ usageBytes: 2_000, limitBytes: 10_000 }),
    onMemorySample: (sample) => {
      samples.push(sample);
    },
    logger: { log: () => undefined, warn: () => undefined },
  });

  supervisor.trackRoot(10);
  await supervisor.sample();

  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], {
    treeRssBytes: 1_100,
    hostUsageBytes: 2_000,
    hostLimitBytes: 10_000,
  });
  supervisor.stop();
});

test("surfaces a supervised abort as one terminal AG-UI error", async () => {
  const supervisor = await trippedCgroupSupervisor();

  async function* failedProvider(): AsyncIterable<StreamChunk> {
    yield {
      type: EventType.RUN_ERROR,
      timestamp: 1,
      message: "process exited with code 143",
    };
  }

  const chunks = await collect(supervisor.guard(failedProvider(), "test-model"));
  assert.equal(chunks.length, 1);
  const chunk = chunks[0]!;
  assert.ok(chunk.type === EventType.RUN_ERROR);
  assert.equal(chunk.code, "AGENT_MEMORY_LIMIT");
  assert.match(chunk.message, /service-cgroup/);
  supervisor.stop();
});

test("replaces an aborted provider exception with one memory error", async () => {
  const supervisor = await trippedCgroupSupervisor();

  async function* abortedProvider(): AsyncIterable<StreamChunk> {
    throw new Error("process aborted");
  }

  const chunks = await collect(
    supervisor.guard(abortedProvider(), "test-model"),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.type, EventType.RUN_ERROR);
  supervisor.stop();
});

test("appends a memory error when an aborted provider ends silently", async () => {
  const supervisor = await trippedCgroupSupervisor();

  async function* silentProvider(): AsyncIterable<StreamChunk> {
    return;
  }

  const chunks = await collect(
    supervisor.guard(silentProvider(), "test-model"),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.type, EventType.RUN_ERROR);
  supervisor.stop();
});

test("does not alter ordinary terminal events", async () => {
  const supervisor = new AgentProcessSupervisor({
    runId: "healthy-run",
    abortController: new AbortController(),
    treeLimitBytes: 10_000,
    cgroupHeadroomBytes: 1_000,
  });
  const finished: StreamChunk = {
    type: EventType.RUN_FINISHED,
    timestamp: 1,
    threadId: "healthy-thread",
    runId: "healthy-run",
  };

  async function* healthyProvider(): AsyncIterable<StreamChunk> {
    yield finished;
  }

  assert.deepEqual(
    await collect(supervisor.guard(healthyProvider(), "test-model")),
    [finished],
  );
});
