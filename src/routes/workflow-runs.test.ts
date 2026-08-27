import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createAgentRunDurability } from "../durability/runtime.js";
import type {
  T3ModelSelection,
  T3OrchestrationSnapshot,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "../t3/client.js";
import type { CentralT3ConversationClient } from "../t3/central-conversation.js";
import { NativeT3RunCoordinator } from "../t3/run-coordinator.js";
import { createWorkflowRunRoutes } from "./workflow-runs.js";

const modelSelection: T3ModelSelection = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
};

function centralClient(): CentralT3ConversationClient & {
  interruptTurn(input: { threadId: string }): Promise<number>;
} {
  let dispatch: T3TurnDispatch | undefined;
  const orchestration: T3OrchestrationSnapshot = {
    snapshotSequence: 1,
    projects: [
      {
        id: "project-central",
        title: "Compadre",
        workspaceRoot: "/workspace",
        defaultModelSelection: modelSelection,
      },
    ],
    threads: [],
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
  return {
    baseUrl: "https://central.example",
    async environmentDescriptor() {
      return {
        environmentId: "environment-central",
        label: "Central",
        serverVersion: "test",
      };
    },
    async snapshot() {
      return orchestration;
    },
    async startNewThread(request) {
      dispatch = {
        sequence: 2,
        commandId: "command-1",
        messageId: request.messageId!,
        threadId: request.threadId!,
        createdAt: "2026-08-27T12:00:00.000Z",
      };
      return dispatch;
    },
    async startTurn() {
      throw new Error("unexpected continuation");
    },
    async waitForTurnTerminal(request) {
      assert.ok(dispatch);
      const snapshot: T3ThreadSnapshot = {
        snapshotSequence: 3,
        thread: {
          id: dispatch.threadId,
          projectId: "project-central",
          title: "Workflow request",
          modelSelection,
          latestTurn: {
            turnId: "turn-1",
            state: "completed",
            requestedAt: dispatch.createdAt,
            startedAt: dispatch.createdAt,
            completedAt: "2026-08-27T12:00:01.000Z",
            assistantMessageId: "assistant-1",
          },
          messages: [
            {
              id: dispatch.messageId,
              role: "user",
              text: "hello",
              turnId: "turn-1",
              streaming: false,
              createdAt: dispatch.createdAt,
              updatedAt: dispatch.createdAt,
            },
            {
              id: "assistant-1",
              role: "assistant",
              text: "central answer",
              turnId: "turn-1",
              streaming: false,
              createdAt: dispatch.createdAt,
              updatedAt: "2026-08-27T12:00:01.000Z",
            },
          ],
          session: { status: "ready", activeTurnId: null, lastError: null },
          activities: [],
        },
      };
      await request.onSnapshot?.(snapshot);
      return snapshot;
    },
    async interruptTurn() {
      return 1;
    },
  };
}

async function withApiKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previous;
  }
}

test("starts a central T3 run and serves resumable compatibility events", async (t) => {
  await withApiKey(async () => {
    const durability = await createAgentRunDurability({
      COMPADRE_DURABILITY_BACKEND: "memory",
    });
    assert.ok(durability);
    t.after(() => durability.close());
    const coordinator = new NativeT3RunCoordinator(durability);
    const app = new Hono();
    app.route(
      "/",
      createWorkflowRunRoutes({
        enabled: () => true,
        getClient: () => centralClient(),
        getRunCoordinator: async () => coordinator,
        createId: () => "route-run",
      }),
    );

    const started = await app.request("/workflow-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(started.status, 202);
    const body = (await started.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      runId: "route-run",
      threadId: "workflow-route-run",
      taskRunId: "central-t3:route-run",
      started: true,
      statusUrl: "/workflow-runs/route-run",
      eventsUrl: "/workflow-runs/route-run/events?offset=-1",
    });

    const stream = await app.request(String(body.eventsUrl), {
      headers: { Authorization: "Bearer test-key" },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const text = await stream.text();
    assert.match(text, /"type":"RUN_STARTED"/);
    assert.match(text, /"type":"TEXT_MESSAGE_CONTENT"/);
    assert.match(text, /"delta":"central answer"/);
    assert.match(text, /"type":"RUN_FINISHED"/);

    const status = await app.request("/workflow-runs/route-run", {
      headers: { Authorization: "Bearer test-key" },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, "completed");
  });
});

test("rejects legacy workflow attachments instead of silently dropping them", async () => {
  await withApiKey(async () => {
    const app = new Hono();
    app.route(
      "/",
      createWorkflowRunRoutes({
        enabled: () => true,
        getClient: () => centralClient(),
        getRunCoordinator: async () => null,
        createId: () => "unused",
      }),
    );
    const response = await app.request("/workflow-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "inspect this",
        inputFiles: [
          {
            name: "input.png",
            mimetype: "image/png",
            sizeBytes: 4,
            dataBase64: "iVBORw==",
          },
        ],
      }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /attachments are not supported/);
  });
});
