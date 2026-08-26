import assert from "node:assert/strict";
import test from "node:test";
import type { T3ThreadSnapshot } from "../t3/client.js";
import type { T3GatewayTurn } from "../t3/gateway.js";
import {
  assistantTextForDispatch,
  canonicalSlackThreadId,
  runT3SlackConversation,
  t3SlackDetailsMarkdown,
} from "./t3-slack-conversation.js";

const turn: T3GatewayTurn = {
  binding: {
    canonicalThreadId: "slack:T1:C1:123.4",
    providerInstanceId: "codex",
    t3ThreadId: "thread-native",
    projectId: "project-1",
    sandboxId: "sandbox-1",
    baseUrl: "https://modal.example",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    createdAt: "2026-08-26T15:00:00.000Z",
    updatedAt: "2026-08-26T15:00:00.000Z",
  },
  dispatch: {
    sequence: 10,
    commandId: "command-1",
    messageId: "user-1",
    threadId: "thread-native",
    createdAt: "2026-08-26T15:00:00.000Z",
  },
};

function snapshot(text: string, state: "running" | "completed"): T3ThreadSnapshot {
  return {
    snapshotSequence: state === "running" ? 11 : 12,
    thread: {
      id: "thread-native",
      projectId: "project-1",
      title: "Slack request",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      latestTurn: {
        turnId: "turn-1",
        state,
        requestedAt: "2026-08-26T15:00:00.000Z",
        startedAt: "2026-08-26T15:00:00.100Z",
        completedAt: state === "completed" ? "2026-08-26T15:00:01.000Z" : null,
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "Question",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-26T15:00:00.000Z",
          updatedAt: "2026-08-26T15:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text,
          turnId: "turn-1",
          streaming: state === "running",
          createdAt: "2026-08-26T15:00:00.100Z",
          updatedAt: "2026-08-26T15:00:01.000Z",
        },
      ],
      session: {
        status: state === "running" ? "running" : "ready",
        activeTurnId: state === "running" ? "turn-1" : null,
        lastError: null,
      },
    },
  };
}

test("streams only assistant text and returns a native T3 deep link", async () => {
  const deltas: string[] = [];
  const result = await runT3SlackConversation({
    gateway: {
      async send() {
        return turn;
      },
      async waitForTerminal(input) {
        await input.onSnapshot?.(snapshot("Hel", "running"));
        await input.onSnapshot?.(snapshot("Hello from T3", "completed"));
        return snapshot("Hello from T3", "completed");
      },
      async open() {
        return { pairingUrl: "https://ui.example/pair#token=once" };
      },
    },
    canonicalThreadId: turn.binding.canonicalThreadId,
    title: "Slack request",
    prompt: "Question",
    displayText: "Question",
    profile: "codex",
    onTextDelta(text) {
      deltas.push(text);
    },
  });

  assert.equal(result.output, "Hello from T3");
  assert.deepEqual(deltas, ["Hel", "lo from T3"]);
  assert.equal(result.detailsUrl, "https://ui.example/pair#token=once");
  assert.equal(result.detailsUrl && t3SlackDetailsMarkdown(result.detailsUrl), "<https://ui.example/pair#token=once|View details in T3>");
});

test("does not project an older assistant turn into Slack", () => {
  const old = snapshot("old answer", "completed");
  old.thread.messages = old.thread.messages.filter((message) => message.id !== "user-1");
  assert.equal(assistantTextForDispatch(old, turn.dispatch), "");
});

test("scopes canonical Slack threads by workspace and channel", () => {
  assert.equal(
    canonicalSlackThreadId({ teamId: "T1", channel: "C1", threadTs: "123.4" }),
    "slack:T1:C1:123.4",
  );
});
