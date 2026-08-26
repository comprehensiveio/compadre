import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { NativeT3SnapshotProjector } from "./agui-stream.js";
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
