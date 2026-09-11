import { MessageId, EventId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveCancelledCompactionMessageIds,
  isCompactCommandMessage,
  isCompactionInProgress,
} from "./compaction";
import type { ChatMessage } from "./types";

const command: ChatMessage = {
  id: MessageId.make("compact"),
  role: "user",
  turnId: null,
  text: "/compact",
  streaming: false,
  createdAt: "2026-09-10T19:42:34.493Z",
  updatedAt: "2026-09-10T19:42:34.493Z",
};

describe("native compaction presentation", () => {
  it("retains native cancellation after checkpoint completion and later messages", () => {
    const receipt = {
      id: EventId.make("interrupted"),
      kind: "provider.turn.completed",
      summary: "Provider turn completed",
      tone: "info" as const,
      turnId: null,
      payload: { state: "interrupted" },
      createdAt: "2026-09-10T19:44:54.415Z",
    };
    const nextMessage = {
      ...command,
      id: MessageId.make("next"),
      text: "Continue",
      createdAt: "2026-09-10T19:45:00.000Z",
    };
    expect(
      deriveCancelledCompactionMessageIds({
        messages: [command, nextMessage],
        activities: [receipt],
      }),
    ).toEqual(new Set([command.id]));
    expect(
      deriveCancelledCompactionMessageIds({
        messages: [command, nextMessage],
        activities: [{ ...receipt, createdAt: "2026-09-10T19:46:00.000Z" }],
      }),
    ).toEqual(new Set());
    expect(
      deriveCancelledCompactionMessageIds({
        messages: [command],
        activities: [{ ...receipt, payload: { state: "completed" } }],
      }),
    ).toEqual(new Set());
  });
  it("recognizes only the server's exact attachment-free command", () => {
    expect(isCompactCommandMessage(command)).toBe(true);
    expect(isCompactCommandMessage({ ...command, text: "  /compact\n" })).toBe(true);
    expect(isCompactCommandMessage({ ...command, text: "/compact explain this" })).toBe(false);
    expect(isCompactCommandMessage({ ...command, text: "/COMPACT" })).toBe(false);
    expect(isCompactCommandMessage({ ...command, role: "assistant" })).toBe(false);
    expect(
      isCompactCommandMessage({
        ...command,
        attachments: [
          { type: "image", id: "image", name: "image", mimeType: "image/png", sizeBytes: 1 },
        ],
      }),
    ).toBe(false);
  });

  it("covers optimistic clicks, server acknowledgement and reload", () => {
    expect(
      isCompactionInProgress({ thread: undefined, optimisticMessages: [command], isWorking: true }),
    ).toBe(true);
    expect(
      isCompactionInProgress({
        thread: { messages: [command], activities: [] },
        optimisticMessages: [],
        isWorking: true,
      }),
    ).toBe(true);
  });

  it.each(["context-compaction", "provider.turn.start.failed", "runtime.error"])(
    "settles on %s, not old receipts",
    (kind) => {
      const activity = {
        id: EventId.make("receipt"),
        kind,
        summary: kind,
        tone: "info" as const,
        turnId: null,
        payload: null,
        createdAt: "2026-09-10T19:44:54.415Z",
      };
      const input = {
        thread: { messages: [command], activities: [activity] },
        optimisticMessages: [],
        isWorking: true,
      };
      expect(isCompactionInProgress(input)).toBe(false);
      expect(
        isCompactionInProgress({
          ...input,
          thread: {
            ...input.thread,
            activities: [{ ...activity, createdAt: "2026-09-10T19:36:00.000Z" }],
          },
        }),
      ).toBe(true);
    },
  );

  it("does not leak compaction into later normal work or a cancelled turn", () => {
    const thread = { messages: [command], activities: [] };
    expect(isCompactionInProgress({ thread, optimisticMessages: [], isWorking: false })).toBe(
      false,
    );
    expect(
      isCompactionInProgress({
        thread: {
          ...thread,
          messages: [command, { ...command, id: MessageId.make("next"), text: "Continue" }],
        },
        optimisticMessages: [],
        isWorking: true,
      }),
    ).toBe(false);
  });
});
