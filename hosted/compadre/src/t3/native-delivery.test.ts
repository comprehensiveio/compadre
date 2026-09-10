import assert from "node:assert/strict";
import test from "node:test";
import { nativeControlSchema, nativeWorkerControl } from "./native-delivery.js";
import { T3Client } from "./client.js";

test("one native question gets one worker command across separate submissions", () => {
  const input = nativeControlSchema.parse({ sourceThreadId: "worker/a", epoch: 3, commandId: "control-1",
    type: "thread.user-input-response-requested", requestId: "compadre-native:worker%2Fa:question-1",
    createdAt: "2026-09-10T00:00:00.000Z", answers: { choice: "A" } });
  const first = nativeWorkerControl(input);
  assert.deepEqual(first, { type: "thread.user-input.respond", commandId: first.commandId,
    threadId: "worker/a", requestId: "question-1", createdAt: input.createdAt, answers: { choice: "A" } });
  const duplicate = nativeWorkerControl({ ...input, commandId: "control-2", epoch: 4,
    createdAt: "2026-09-10T00:00:01.000Z", answers: { choice: "B" } });
  assert.equal(duplicate.commandId, first.commandId);
  assert.notEqual(nativeWorkerControl({ ...input, requestId: "compadre-native:worker%2Fa:question-2" }).commandId, first.commandId);
  assert.notEqual(nativeWorkerControl({ ...input, sourceThreadId: "worker/b", requestId: "compadre-native:worker%2Fb:question-1" }).commandId, first.commandId);
  assert.throws(() => nativeWorkerControl({ ...input, sourceThreadId: "worker/b" }), /different worker/);
  const approval = { ...input, type: "thread.approval-response-requested" as const, decision: "accept" as const };
  assert.equal(nativeWorkerControl(approval).commandId,
    nativeWorkerControl({ ...approval, commandId: "another-click" }).commandId);
  assert.notEqual(nativeWorkerControl(approval).commandId, first.commandId);
  for (const type of ["thread.turn-interrupt-requested", "thread.session-stop-requested"] as const) {
    assert.equal(nativeWorkerControl({ ...input, type }).commandId, input.commandId);
    assert.equal(nativeWorkerControl({ ...input, type, commandId: "next-intent" }).commandId, "next-intent");
  }
});

test("an accepted worker dispatch can be retried with exactly the same command and user message", async () => {
  const bodies: unknown[] = [];
  const client = new T3Client("https://worker.example", "token", { fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ sequence: 8 }), { headers: { "content-type": "application/json" } });
  } });
  const request = { threadId: "worker", commandId: "native-turn:run-1", messageId: "native-user:run-1",
    createdAt: "2026-09-10T00:00:00.000Z", text: "Continue", modelSelection: { instanceId: "codex", model: "test" } };
  assert.deepEqual(await client.startTurn(request), await client.startTurn(request));
  assert.deepEqual(bodies[0], bodies[1]);
});
