import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "./agui-protocol.js";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
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
