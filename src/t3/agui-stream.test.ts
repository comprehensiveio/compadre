import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "./agui-protocol.js";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  createNativeT3AguiStream,
  NativeT3SnapshotProjector,
  traceNativeT3AguiStream,
} from "./agui-stream.js";
import type { T3ThreadSnapshot } from "./client.js";

function snapshot(input: {
  sequence: number;
  state: "running" | "completed";
  text: string;
  streaming: boolean;
  activities?: ReadonlyArray<unknown>;
}): T3ThreadSnapshot {
  return {
    snapshotSequence: input.sequence,
    thread: {
      id: "worker-thread",
      projectId: "project",
      title: "Central thread",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      latestTurn: {
        turnId: "turn-1",
        state: input.state,
        requestedAt: "2026-08-26T16:00:00.000Z",
        startedAt: "2026-08-26T16:00:00.100Z",
        completedAt: input.state === "completed" ? "2026-08-26T16:00:02.000Z" : null,
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "run pwd",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-26T16:00:00.000Z",
          updatedAt: "2026-08-26T16:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: input.text,
          turnId: "turn-1",
          streaming: input.streaming,
          createdAt: "2026-08-26T16:00:00.200Z",
          updatedAt: "2026-08-26T16:00:01.000Z",
        },
      ],
      session: {
        status: input.state === "completed" ? "ready" : "running",
        activeTurnId: input.state === "completed" ? null : "turn-1",
        lastError: null,
      },
      activities: input.activities ?? [],
    },
  };
}

test("projects native T3 text and tool snapshots incrementally", () => {
  const projector = new NativeT3SnapshotProjector("run-1", "central-thread", "user-1");
  const first = projector.project(snapshot({
    sequence: 4,
    state: "running",
    text: "hello",
    streaming: true,
    activities: [{
      id: "activity-start",
      kind: "tool.started",
      turnId: "turn-1",
      summary: "Command run started",
      createdAt: "2026-08-26T16:00:00.400Z",
      payload: {
        toolCallId: "tool-1",
        itemType: "command_execution",
        detail: "Bash: pwd",
        data: { command: "pwd" },
      },
    }],
  }));
  const second = projector.project(snapshot({
    sequence: 8,
    state: "completed",
    text: "hello world",
    streaming: false,
    activities: [
      {
        id: "activity-start",
        kind: "tool.started",
        turnId: "turn-1",
        summary: "Command run started",
        createdAt: "2026-08-26T16:00:00.400Z",
        payload: { toolCallId: "tool-1", detail: "Bash: pwd", data: {} },
      },
      {
        id: "activity-complete",
        kind: "tool.completed",
        turnId: "turn-1",
        summary: "Command run",
        createdAt: "2026-08-26T16:00:00.800Z",
        payload: {
          toolCallId: "tool-1",
          detail: "Bash: pwd",
          status: "completed",
          data: { command: "pwd" },
        },
      },
    ],
  }));
  const events = [...first, ...second] as StreamChunk[];

  assert.deepEqual(events.map((event) => event.type), [
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TOOL_CALL_RESULT,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  assert.equal(
    events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta).join(""),
    "hello world",
  );
  const toolStart = events.find((event) => event.type === EventType.TOOL_CALL_START);
  assert.equal(toolStart?.toolName, "Bash");
  assert.equal(toolStart?.itemType, "command_execution");
  assert.equal(toolStart?.title, "Command run");
  assert.equal(toolStart?.detail, "Bash: pwd");
  assert.deepEqual(toolStart?.data, { command: "pwd" });
  const toolResult = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.equal(toolResult?.itemType, "command_execution");
  assert.deepEqual(toolResult?.data, { command: "pwd" });
});

test("ignores a stale terminal snapshot from before the requested message", () => {
  const projector = new NativeT3SnapshotProjector("run-1", "central-thread", "new-user");
  assert.deepEqual(projector.project(snapshot({
    sequence: 2,
    state: "completed",
    text: "old answer",
    streaming: false,
  })), []);
});

test("projects provider failures that happen before a turn is assigned", () => {
  const projector = new NativeT3SnapshotProjector(
    "run-1",
    "central-thread",
    "user-1",
  );
  const failed: T3ThreadSnapshot = {
    snapshotSequence: 5,
    thread: {
      id: "worker-thread",
      projectId: "project",
      title: "Central thread",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5",
      },
      latestTurn: {
        turnId: "prior-turn",
        state: "completed",
        requestedAt: "2026-08-26T15:00:00.000Z",
        startedAt: "2026-08-26T15:00:00.000Z",
        completedAt: "2026-08-26T15:00:01.000Z",
        assistantMessageId: "prior-assistant",
      },
      messages: [{
        id: "user-1",
        role: "user",
        text: "run pwd",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-26T16:00:00.000Z",
        updatedAt: "2026-08-26T16:00:00.000Z",
      }],
      session: {
        status: "stopped",
        activeTurnId: null,
        lastError: "turn/setPermissionMode failed",
      },
      activities: [{
        id: "start-failed",
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        createdAt: "2026-08-26T16:00:00.100Z",
      }],
    },
  };

  const events = projector.project(failed);

  assert.deepEqual(events, [{
    type: EventType.RUN_ERROR,
    runId: "run-1",
    message: "turn/setPermissionMode failed",
    timestamp: Date.parse("2026-08-26T16:00:00.100Z"),
  }]);
  assert.deepEqual(projector.project(failed), []);
});

test("preserves the native MCP server and tool name", () => {
  const projector = new NativeT3SnapshotProjector("run-1", "central-thread", "user-1");
  const events = projector.project(snapshot({
    sequence: 4,
    state: "running",
    text: "",
    streaming: true,
    activities: [{
      id: "mcp-start",
      kind: "tool.started",
      turnId: "turn-1",
      summary: "compadre · github_search_repositories started",
      createdAt: "2026-08-26T16:00:00.400Z",
      payload: {
        toolCallId: "mcp-1",
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            server: "compadre",
            tool: "github_search_repositories",
            arguments: { query: "user:tanstack" },
          },
        },
      },
    }],
  }));

  const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
  assert.equal(start?.toolCallName, "compadre · github_search_repositories");
  assert.equal(start?.toolName, "compadre · github_search_repositories");
  assert.equal(start?.itemType, "mcp_tool_call");
  assert.deepEqual(start?.data, {
    item: {
      type: "mcpToolCall",
      server: "compadre",
      tool: "github_search_repositories",
      arguments: { query: "user:tanstack" },
    },
  });
});

test("projects every assistant segment from a native T3 turn", () => {
  const projector = new NativeT3SnapshotProjector("run-1", "central-thread", "user-1");
  const first = snapshot({
    sequence: 4,
    state: "running",
    text: "I will gather the data.",
    streaming: false,
  });
  const terminalSnapshot = snapshot({
    sequence: 12,
    state: "completed",
    text: "I will gather the data.",
    streaming: false,
  });
  const terminal: T3ThreadSnapshot = {
    ...terminalSnapshot,
    thread: {
      ...terminalSnapshot.thread,
      messages: [
        ...terminalSnapshot.thread.messages,
        {
          id: "assistant-2",
          role: "assistant",
          text: "I found compatible sources.",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-26T16:00:01.100Z",
          updatedAt: "2026-08-26T16:00:01.100Z",
        },
        {
          id: "assistant-3",
          role: "assistant",
          text: "Here is the completed joined result.",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-26T16:00:02.000Z",
          updatedAt: "2026-08-26T16:00:02.000Z",
        },
      ],
    },
  };

  const events = [...projector.project(first), ...projector.project(terminal)];
  assert.deepEqual(
    events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_START)
      .map((event) => event.messageId),
    ["assistant-1", "assistant-2", "assistant-3"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta),
    [
      "I will gather the data.",
      "I found compatible sources.",
      "Here is the completed joined result.",
    ],
  );
  assert.equal(
    events.filter((event) => event.type === EventType.TEXT_MESSAGE_END).length,
    3,
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("keeps a provider span open for the full native T3 stream", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  async function* source(): AsyncIterable<StreamChunk> {
    yield {
      type: EventType.RUN_STARTED,
      runId: "run-telemetry",
      threadId: "thread-telemetry",
    };
    yield {
      type: EventType.RUN_FINISHED,
      runId: "run-telemetry",
      threadId: "thread-telemetry",
      finishReason: "stop",
    };
  }

  for await (const _event of traceNativeT3AguiStream(source(), {
    canonicalThreadId: "thread-telemetry",
    runId: "run-telemetry",
    provider: "claude-code",
    model: "claude-opus-5",
    tracer,
  })) {
    // Consume the complete stream so the span finalizer runs.
  }

  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "compadre.t3.provider.turn");
  assert.equal(span?.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(span?.attributes["gen_ai.request.model"], "claude-opus-5");
  assert.equal(span?.attributes["agui.thread_id"], "thread-telemetry");
  await provider.shutdown();
});

test("publishes durable output artifacts before finishing the provider run", async () => {
  const terminal = snapshot({
    sequence: 8,
    state: "completed",
    text: "Here is the file.",
    streaming: false,
  });
  const events: StreamChunk[] = [];
  for await (const event of createNativeT3AguiStream({
    gateway: {
      async send() {
        return {
          binding: {
            canonicalThreadId: "central-thread",
            providerInstanceId: "codex",
            t3ThreadId: "worker-thread",
            projectId: "project",
            sandboxId: "sandbox-1",
            baseUrl: "https://sandbox.test",
            modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
            status: "working",
            createdAt: "2026-08-26T16:00:00.000Z",
            updatedAt: "2026-08-26T16:00:00.000Z",
          },
          dispatch: {
            sequence: 1,
            commandId: "command-1",
            messageId: "user-1",
            threadId: "worker-thread",
            createdAt: "2026-08-26T16:00:00.000Z",
          },
        };
      },
      async waitForTerminal({ onSnapshot }) {
        await onSnapshot?.(terminal);
        return terminal;
      },
    },
    canonicalThreadId: "central-thread",
    runId: "run-1",
    title: "Artifact test",
    text: "create a file",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    async outputArtifactEvents() {
      return [{
        type: EventType.OUTPUT_ARTIFACT,
        artifact: {
          artifactId: "a".repeat(64),
          path: "proof.png",
          name: "proof.png",
          title: "Proof",
          mimetype: "image/png",
          sizeBytes: 8,
          storage: "hosted-object",
        },
      }];
    },
  })) {
    events.push(event);
  }

  const artifactIndex = events.findIndex((event) => event.type === EventType.OUTPUT_ARTIFACT);
  const finishedIndex = events.findIndex((event) => event.type === EventType.RUN_FINISHED);
  assert.ok(artifactIndex >= 0);
  assert.ok(finishedIndex > artifactIndex);
});
