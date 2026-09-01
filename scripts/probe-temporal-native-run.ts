/**
 * End-to-end probe for the Temporal-orchestrated native T3 run path.
 *
 * Requires the local Temporal server:  npm run temporal:up
 *
 * Proves, against a REAL Temporal server and worker (fake Modal gateway,
 * memory durability):
 *  1. POST /hosted/t3/chat launches a durable workflow and streams SSE from
 *     the durable log.
 *  2. A drive attempt that dies mid-watch is retried by Temporal and RESUMES
 *     projection: no duplicated events, the worker turn is dispatched once.
 *  3. POST /hosted/t3/runs/:id/cancel cancels the workflow; the run record
 *     converges to "aborted" and the worker turn is interrupted.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Hono } from "hono";
import { createAgentRunDurability } from "../src/durability/runtime.js";
import { createT3DirectoryRoutes } from "../src/routes/t3-directory.js";
import { EventType, type StreamChunk } from "../src/t3/agui-protocol.js";
import type { T3ThreadSnapshot, T3TurnDispatch } from "../src/t3/client.js";
import type { T3GatewayTurn } from "../src/t3/gateway.js";
import type { NativeT3DriverGateway } from "../src/t3/native-t3-run-driver.js";
import { NativeT3RunCoordinator } from "../src/t3/run-coordinator.js";
import { NativeT3RunRequestStore } from "../src/t3/run-request-store.js";
import {
  createTemporalNativeT3WorkflowLauncher,
  TemporalNativeT3RunService,
} from "../src/t3/run-service.js";
import { setNativeT3RunDriverDependenciesForTests } from "../src/t3/runtime.js";
import type { T3ThreadBinding } from "../src/services/t3-thread-bindings.js";
import type { MetadataStore } from "../src/t3/storage.js";
import { startNativeT3TemporalWorker } from "../src/temporal/worker.js";

process.env.TEMPORAL_ADDRESS ||= "localhost:7243";
process.env.TEMPORAL_NAMESPACE ||= "compadre-probe";
process.env.COMPADRE_API_KEY ||= crypto.randomBytes(16).toString("hex");
delete process.env.SLACK_BOT_TOKEN;

const binding: T3ThreadBinding = {
  canonicalThreadId: "probe-thread",
  providerInstanceId: "claudeAgent",
  t3ThreadId: "probe-native-thread",
  projectId: "probe-project",
  sandboxId: "probe-sandbox",
  baseUrl: "https://probe.invalid",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  status: "working",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function snapshotAt(input: {
  messageId: string;
  assistantText: string;
  terminal: boolean;
}): T3ThreadSnapshot {
  return {
    snapshotSequence: input.terminal ? 9 : 5,
    thread: {
      id: "probe-native-thread",
      projectId: "probe-project",
      title: "Temporal probe",
      modelSelection: binding.modelSelection,
      latestTurn: {
        turnId: "turn-1",
        state: input.terminal ? "completed" : "running",
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: input.terminal ? new Date().toISOString() : null,
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: input.messageId,
          role: "user",
          text: "probe",
          turnId: "turn-1",
          streaming: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: input.assistantText,
          turnId: "turn-1",
          streaming: !input.terminal,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      session: { status: "ready", activeTurnId: null, lastError: null },
    },
  } as unknown as T3ThreadSnapshot;
}

function memoryMetadata(): MetadataStore {
  const data = new Map<string, unknown>();
  return {
    async get(namespace, key) {
      const value = data.get(`${namespace}:${key}`);
      return value === undefined ? null : value;
    },
    async set(namespace, key, value) {
      data.set(`${namespace}:${key}`, JSON.parse(JSON.stringify(value)));
    },
    async delete(namespace, key) {
      data.delete(`${namespace}:${key}`);
    },
  };
}

interface ProbeGatewayState {
  sends: number;
  waits: number;
  cancels: number;
}

function probeGateway(
  behavior: "retry-then-complete" | "hang-until-cancel",
): { gateway: NativeT3DriverGateway; state: ProbeGatewayState } {
  const state: ProbeGatewayState = { sends: 0, waits: 0, cancels: 0 };
  let messageId = "";
  const gateway: NativeT3DriverGateway = {
    async send() {
      state.sends += 1;
      messageId = `message-${state.sends}`;
      const dispatch: T3TurnDispatch = {
        sequence: 3,
        commandId: "command-1",
        messageId,
        threadId: binding.t3ThreadId,
        createdAt: new Date().toISOString(),
      };
      return { binding, dispatch } satisfies T3GatewayTurn;
    },
    async resumeTurn(_canonicalThreadId, dispatch) {
      return { binding, dispatch };
    },
    async waitForTerminal({ onSnapshot, signal }) {
      state.waits += 1;
      if (behavior === "retry-then-complete") {
        if (state.waits === 1) {
          await onSnapshot?.(
            snapshotAt({ messageId, assistantText: "Reliability is a", terminal: false }),
          );
          // Simulate the controller dying mid-watch: the activity attempt
          // fails and Temporal must retry it.
          throw new Error("probe: controller crashed mid-watch");
        }
        const terminal = snapshotAt({
          messageId,
          assistantText: "Reliability is a durable workflow.",
          terminal: true,
        });
        await onSnapshot?.(terminal);
        return terminal;
      }
      await onSnapshot?.(
        snapshotAt({ messageId, assistantText: "Working...", terminal: false }),
      );
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("probe: watch aborted"));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      });
    },
    async cancel() {
      state.cancels += 1;
      return 1;
    },
  };
  return { gateway, state };
}

function authorized(body?: unknown): RequestInit {
  return {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Authorization: `Bearer ${process.env.COMPADRE_API_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  };
}

function chatBody(runId: string, threadId: string) {
  return {
    runId,
    threadId,
    messages: [{ id: "input-1", role: "user", content: "probe the workflow" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { provider: "claude-code", model: "claude-opus-5" },
  };
}

function sseChunks(body: string): StreamChunk[] {
  return body
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (!data || data === "[DONE]") return [];
      return [JSON.parse(data) as StreamChunk];
    });
}

async function main() {
  const durability = await createAgentRunDurability({
    COMPADRE_DURABILITY_BACKEND: "memory",
  });
  assert.ok(durability);
  const requests = new NativeT3RunRequestStore(memoryMetadata());
  const coordinator = new NativeT3RunCoordinator(durability);
  const service = new TemporalNativeT3RunService(
    coordinator,
    requests,
    createTemporalNativeT3WorkflowLauncher(),
  );
  const app = new Hono();
  app.route(
    "/",
    createT3DirectoryRoutes({
      enabled: () => true,
      createId: () => crypto.randomUUID(),
      getGateway: async () =>
        ({
          async list() {
            return [];
          },
        }) as never,
      getRunService: async () => service,
      watchTurn() {},
      async getSlackBinding() {
        return null;
      },
    }),
  );

  console.log("[probe] starting Temporal worker...");
  const worker = await startNativeT3TemporalWorker();
  try {
    // Scenario 1: crash mid-watch, Temporal retries, projection resumes.
    {
      const { gateway, state } = probeGateway("retry-then-complete");
      setNativeT3RunDriverDependenciesForTests({ gateway, durability, requests });
      const runId = `probe-run-${crypto.randomUUID()}`;
      const threadId = `probe-thread-${crypto.randomUUID()}`;
      console.log(`[probe] scenario 1: runId=${runId}`);
      const response = await app.request(
        "/hosted/t3/chat",
        authorized(chatBody(runId, threadId)),
      );
      assert.equal(response.status, 200, await response.clone().text());
      const events = sseChunks(await response.text());
      const types = events.map((event) => event.type);
      console.log("[probe] scenario 1 events:", JSON.stringify(types));
      console.log("[probe] scenario 1 run:", JSON.stringify(await durability.runs.get(runId)));
      console.log("[probe] scenario 1 gateway state:", JSON.stringify(state));

      assert.equal(state.sends, 1, "worker turn dispatched exactly once");
      assert.ok(state.waits >= 2, `expected a Temporal retry, saw ${state.waits} watch attempts`);
      assert.equal(types.filter((type) => type === EventType.RUN_STARTED).length, 1);
      assert.equal(types.filter((type) => type === EventType.TEXT_MESSAGE_START).length, 1);
      assert.equal(types.filter((type) => type === EventType.RUN_FINISHED).length, 1);
      const text = events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta)
        .join("");
      assert.equal(text, "Reliability is a durable workflow.");
      const run = await durability.runs.get(runId);
      assert.equal(run?.status, "completed");
      console.log("[probe] scenario 1 passed: retry resumed without duplication");
    }

    // Scenario 2: cancellation through the workflow.
    {
      const { gateway, state } = probeGateway("hang-until-cancel");
      setNativeT3RunDriverDependenciesForTests({ gateway, durability, requests });
      const runId = `probe-run-${crypto.randomUUID()}`;
      const threadId = `probe-thread-${crypto.randomUUID()}`;
      console.log(`[probe] scenario 2: runId=${runId}`);
      const streaming = app.request(
        "/hosted/t3/chat",
        authorized(chatBody(runId, threadId)),
      );
      // Wait for the run to reach the durable log before cancelling.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const chunks = await durability.stream(runId).snapshot();
        if (chunks.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const cancelResponse = await app.request(
        `/hosted/t3/runs/${runId}/cancel`,
        authorized({}),
      );
      assert.ok(
        cancelResponse.status === 202 || cancelResponse.status === 200,
        `cancel status ${cancelResponse.status}`,
      );
      const response = await streaming;
      const events = sseChunks(await response.text());
      assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
      const finalRunDeadline = Date.now() + 30_000;
      let finalStatus: string | undefined;
      while (Date.now() < finalRunDeadline) {
        finalStatus = (await durability.runs.get(runId))?.status;
        if (finalStatus === "aborted") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(finalStatus, "aborted");
      assert.ok(state.cancels >= 1, "worker turn was interrupted");
      console.log("[probe] scenario 2 passed: durable cancellation converged");
    }

    console.log("[probe] all scenarios passed");
  } finally {
    setNativeT3RunDriverDependenciesForTests(undefined);
    await worker.shutdown().catch(() => undefined);
    await durability.close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[probe] failed:", error);
  console.error("Is the local Temporal server running? Start it with: npm run temporal:up");
  process.exit(1);
});
