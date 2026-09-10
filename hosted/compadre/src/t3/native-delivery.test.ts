import assert from "node:assert/strict";
import test from "node:test";
import { nativeControlSchema, nativeWorkerControl } from "./native-delivery.js";
import { T3Client } from "./client.js";

test("question controls retain their command identity and reject another worker's requests", () => {
  const input = nativeControlSchema.parse({ sourceThreadId: "worker/a", epoch: 3, commandId: "control-1",
    type: "thread.user-input-response-requested", requestId: "compadre-native:worker%2Fa:question-1",
    createdAt: "2026-09-10T00:00:00.000Z", answers: { choice: "A" } });
  assert.deepEqual(nativeWorkerControl(input), { type: "thread.user-input.respond", commandId: "control-1",
    threadId: "worker/a", requestId: "question-1", createdAt: input.createdAt, answers: { choice: "A" } });
  assert.throws(() => nativeWorkerControl({ ...input, sourceThreadId: "worker/b" }), /different worker/);
  assert.equal(nativeWorkerControl({ ...input, type: "thread.turn-interrupt-requested" }).type, "thread.turn.interrupt");
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
