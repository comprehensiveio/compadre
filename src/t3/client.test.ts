import assert from "node:assert/strict";
import test from "node:test";
import {
  exchangeT3PairingToken,
  incompleteProviderStopReason,
  T3Client,
  T3GatewayError,
} from "./client.js";

test("detects only incomplete provider stop reasons for the current turn", () => {
  const base = {
    snapshotSequence: 1,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      latestTurn: {
        turnId: "turn-2",
        state: "completed" as const,
        requestedAt: now.toISOString(),
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        assistantMessageId: "assistant-2",
      },
      messages: [],
      session: null,
      activities: [
        {
          id: "old",
          kind: "provider.turn.completed",
          turnId: "turn-1",
          payload: { stopReason: "max_tokens" },
        },
        {
          id: "current",
          kind: "provider.turn.completed",
          turnId: "turn-2",
          payload: { stopReason: "max_turn_requests" },
        },
      ],
    },
  };
  assert.equal(incompleteProviderStopReason(base, "turn-2"), "max_turn_requests");
  const complete = structuredClone(base);
  complete.thread.activities[1]!.payload.stopReason = "end_turn";
  assert.equal(incompleteProviderStopReason(complete, "turn-2"), undefined);
});

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
    text: "Please fix the failing test\n\nSlack routing metadata",
    displayText: "Please fix the failing test",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    attribution: {
      userId: "user-1",
      displayName: "Isaac",
      origin: "slack",
      slack: {
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
        messageTs: "123.4",
      },
    },
    inputFiles: [
      {
        name: "screenshot.png",
        mimetype: "image/png",
        sizeBytes: 3,
        dataBase64: "AQID",
      },
    ],
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
      providerPrompt: "Please fix the failing test\n\nSlack routing metadata",
      attachments: [
        {
          type: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,AQID",
        },
      ],
      attribution: {
        userId: "user-1",
        displayName: "Isaac",
        origin: "slack",
        slack: {
          workspaceId: "T1",
          userId: "U1",
          channelId: "C1",
          messageTs: "123.4",
        },
      },
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

test("reads the public T3 environment identity without sending the service token", async () => {
  let request: Request | undefined;
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async (input, init) => {
      request = new Request(input, init);
      return json({
        environmentId: "environment-central",
        label: "Central T3",
        serverVersion: "0.0.33",
      });
    },
  });

  assert.deepEqual(await client.environmentDescriptor(), {
    environmentId: "environment-central",
    label: "Central T3",
    serverVersion: "0.0.33",
  });
  assert.equal(
    request?.url,
    "https://t3.example/.well-known/t3/environment",
  );
  assert.equal(request?.headers.get("authorization"), null);
});

test("retries a transient gateway response while reading the orchestration snapshot", async () => {
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("upstream unavailable", { status: 502 })
        : json({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now.toISOString() });
    },
  });

  const snapshot = await client.snapshot();

  assert.equal(calls, 2);
  assert.equal(snapshot.snapshotSequence, 1);
});

test("preserves native T3 activity and tool detail fields in thread snapshots", async () => {
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () =>
      json({
        snapshotSequence: 12,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
          latestTurn: null,
          messages: [],
          session: null,
          activities: [
            {
              id: "activity-1",
              type: "command.completed",
              command: "pwd",
              output: "/workspace",
            },
          ],
        },
      }),
  });

  const snapshot = await client.threadSnapshot("thread-1");
  assert.deepEqual(snapshot.thread.activities, [
    {
      id: "activity-1",
      type: "command.completed",
      command: "pwd",
      output: "/workspace",
    },
  ]);
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

test("retries a transient non-JSON gateway response while waiting for a turn", async () => {
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("upstream unavailable", { status: 502 });
      }
      return json({
        snapshotSequence: 11,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          latestTurn: {
            turnId: "turn-1",
            state: "completed",
            requestedAt: now.toISOString(),
            startedAt: now.toISOString(),
            completedAt: now.toISOString(),
            assistantMessageId: "assistant-1",
          },
          messages: [],
          session: null,
        },
      });
    },
  });

  const result = await client.waitForTurnTerminal({
    threadId: "thread-1",
    minimumSequence: 10,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  assert.equal(calls, 2);
  assert.equal(result.thread.latestTurn?.state, "completed");
});

test("returns when a provider fails before assigning a turn", async () => {
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () => {
      calls += 1;
      return json({
        snapshotSequence: 12,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
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
            id: "requested-message",
            role: "user",
            text: "new request",
            turnId: null,
            streaming: false,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          }],
          session: {
            status: "stopped",
            activeTurnId: null,
            lastError: "turn/setPermissionMode failed",
          },
          activities: [{
            id: "start-failed",
            kind: "provider.turn.start.failed",
            createdAt: now.toISOString(),
          }],
        },
      });
    },
  });

  const result = await client.waitForTurnTerminal({
    threadId: "thread-1",
    minimumSequence: 10,
    messageId: "requested-message",
    requestedAt: now.toISOString(),
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  assert.equal(calls, 1);
  assert.equal(result.thread.latestTurn?.turnId, "prior-turn");
  assert.equal(
    result.thread.session?.lastError,
    "turn/setPermissionMode failed",
  );
});

test("does not retry a non-transient snapshot failure", async () => {
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    fetch: async () => {
      calls += 1;
      return json({ _tag: "Unauthorized" }, 401);
    },
  });

  await assert.rejects(
    client.waitForTurnTerminal({
      threadId: "thread-1",
      minimumSequence: 10,
      pollIntervalMs: 1,
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.ok(error instanceof T3GatewayError);
      assert.equal(error.status, 401);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("extends the inactivity deadline while snapshot progress continues", async () => {
  let clock = Date.parse("2026-08-26T15:00:00.000Z");
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    now: () => new Date(clock),
    fetch: async () => {
      calls += 1;
      clock += 8;
      return json({
        snapshotSequence: calls,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          latestTurn: {
            turnId: "turn-1",
            state: calls === 4 ? "completed" : "running",
            requestedAt: now.toISOString(),
            startedAt: now.toISOString(),
            completedAt: calls === 4 ? now.toISOString() : null,
            assistantMessageId: calls === 4 ? "assistant-1" : null,
          },
          messages: [],
          session: null,
        },
      });
    },
  });

  const result = await client.waitForTurnTerminal({
    threadId: "thread-1",
    minimumSequence: 1,
    timeoutMs: 10,
    absoluteTimeoutMs: 100,
    pollIntervalMs: 1,
  });

  assert.equal(calls, 4);
  assert.equal(result.thread.latestTurn?.state, "completed");
  assert.ok(clock - Date.parse("2026-08-26T15:00:00.000Z") > 10);
});

test("stops a progressing turn at its absolute deadline", async () => {
  let clock = Date.parse("2026-08-26T15:00:00.000Z");
  let calls = 0;
  const client = new T3Client("https://t3.example", "secret", {
    now: () => new Date(clock),
    fetch: async () => {
      calls += 1;
      clock += 10;
      return json({
        snapshotSequence: calls,
        thread: {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          latestTurn: {
            turnId: "turn-1",
            state: "running",
            requestedAt: now.toISOString(),
            startedAt: now.toISOString(),
            completedAt: null,
            assistantMessageId: null,
          },
          messages: [],
          session: null,
        },
      });
    },
  });

  await assert.rejects(
    client.waitForTurnTerminal({
      threadId: "thread-1",
      minimumSequence: 1,
      timeoutMs: 15,
      absoluteTimeoutMs: 25,
      pollIntervalMs: 1,
    }),
    /absolute deadline of 25ms/,
  );
  assert.equal(calls, 3);
});
