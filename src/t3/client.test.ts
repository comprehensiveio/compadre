import assert from "node:assert/strict";
import test from "node:test";
import {
  exchangeT3PairingToken,
  T3Client,
  T3GatewayError,
} from "./client.js";

const now = new Date("2026-08-26T15:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("exchanges a one-time pairing credential for a scoped bot session", async () => {
  let request: Request | undefined;
  const result = await exchangeT3PairingToken({
    baseUrl: "https://t3.example/",
    pairingToken: "PAIRING-TOKEN",
    scopes: ["orchestration:read", "orchestration:operate"],
    fetch: async (input, init) => {
      request = new Request(input, init);
      return json({
        access_token: "access-token",
        issued_token_type:
          "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read orchestration:operate",
      });
    },
  });

  assert.equal(request?.url, "https://t3.example/oauth/token");
  assert.equal(request?.headers.get("authorization"), null);
  assert.equal(
    request?.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  const form = new URLSearchParams(await request?.text());
  assert.equal(form.get("subject_token"), "PAIRING-TOKEN");
  assert.equal(form.get("client_device_type"), "bot");
  assert.equal(
    form.get("scope"),
    "orchestration:read orchestration:operate",
  );
  assert.deepEqual(result.scopes, [
    "orchestration:read",
    "orchestration:operate",
  ]);
  assert.equal(result.accessToken, "access-token");
});

test("creates a native T3 thread before dispatching its first HTTP turn", async () => {
  const requests: Request[] = [];
  const ids = ["thread-1", "create-command", "turn-command", "message-1"];
  const client = new T3Client("https://t3.example", "access-token", {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return json({ sequence: requests.length === 1 ? 41 : 42 });
    },
    idFactory: () => ids.shift()!,
    now: () => now,
  });

  const dispatch = await client.startNewThread({
    projectId: "project-1",
    title: "Slack thread",
    text: "Please fix the failing test",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  });

  assert.deepEqual(dispatch, {
    sequence: 42,
    commandId: "turn-command",
    messageId: "message-1",
    threadId: "thread-1",
    createdAt: now.toISOString(),
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer access-token",
  );
  assert.deepEqual(await requests[0]?.json(), {
    type: "thread.create",
    commandId: "create-command",
    threadId: "thread-1",
    projectId: "project-1",
    title: "Slack thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now.toISOString(),
  });
  assert.deepEqual(await requests[1]?.json(), {
    type: "thread.turn.start",
    commandId: "turn-command",
    threadId: "thread-1",
    message: {
      messageId: "message-1",
      role: "user",
      text: "Please fix the failing test",
      attachments: [],
    },
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now.toISOString(),
  });
});

test("classifies authenticated T3 failures without copying response content", async () => {
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () =>
      json(
        {
          _tag: "EnvironmentScopeRequiredError",
          message: "sensitive upstream detail",
        },
        403,
      ),
  });

  await assert.rejects(client.snapshot(), (error: unknown) => {
    assert.ok(error instanceof T3GatewayError);
    assert.equal(error.kind, "http");
    assert.equal(error.status, 403);
    assert.equal(error.code, "EnvironmentScopeRequiredError");
    assert.doesNotMatch(error.message, /sensitive|secret/);
    return true;
  });
});

test("waits for the dispatched message instead of accepting a stale terminal turn", async () => {
  let calls = 0;
  const thread = (
    sequence: number,
    state: "running" | "completed",
    current: boolean,
  ) => ({
    snapshotSequence: sequence,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      latestTurn: {
        turnId: "turn-1",
        state,
        requestedAt: current
          ? now.toISOString()
          : "2026-08-26T14:00:00.000Z",
        startedAt: now.toISOString(),
        completedAt: state === "completed" ? now.toISOString() : null,
        assistantMessageId: state === "completed" ? "assistant-1" : null,
      },
      messages: current
        ? [
            {
              id: "requested-message",
              role: "user" as const,
              text: "new request",
              turnId: "turn-1",
              streaming: false,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          ]
        : [],
      session: null,
    },
  });
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () => {
      calls += 1;
      return json(
        calls === 1
          ? thread(9, "completed", false)
          : calls === 2
            ? thread(10, "running", true)
            : thread(11, "completed", true),
      );
    },
  });

  const result = await client.waitForTurnTerminal({
    threadId: "thread-1",
    minimumSequence: 9,
    messageId: "requested-message",
    requestedAt: now.toISOString(),
    pollIntervalMs: 1,
    timeoutMs: 100,
  });
  assert.equal(calls, 3);
  assert.equal(result.thread.latestTurn?.state, "completed");
});
