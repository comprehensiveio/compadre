import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetConfiguredThreadPersistenceForTests } from "../persistence/runtime.js";
import { aguiRoutes } from "./agui.js";

const originalEnabled = process.env.COMPADRE_TANSTACK_AI_ENABLED;
const originalApiKey = process.env.COMPADRE_API_KEY;
const originalPersistenceEnabled =
  process.env.COMPADRE_THREAD_PERSISTENCE_ENABLED;

afterEach(() => {
  if (originalEnabled === undefined) {
    delete process.env.COMPADRE_TANSTACK_AI_ENABLED;
  } else {
    process.env.COMPADRE_TANSTACK_AI_ENABLED = originalEnabled;
  }
  if (originalApiKey === undefined) {
    delete process.env.COMPADRE_API_KEY;
  } else {
    process.env.COMPADRE_API_KEY = originalApiKey;
  }
  if (originalPersistenceEnabled === undefined) {
    delete process.env.COMPADRE_THREAD_PERSISTENCE_ENABLED;
  } else {
    process.env.COMPADRE_THREAD_PERSISTENCE_ENABLED = originalPersistenceEnabled;
  }
  resetConfiguredThreadPersistenceForTests();
});

test("AG-UI route stays dark unless the endpoint is enabled", async () => {
  delete process.env.COMPADRE_TANSTACK_AI_ENABLED;
  const response = await aguiRoutes.request("/ag-ui", { method: "POST" });
  assert.equal(response.status, 404);
});

test("AG-UI route requires an API key when enabled", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  delete process.env.COMPADRE_API_KEY;
  const response = await aguiRoutes.request("/ag-ui", { method: "POST" });
  assert.equal(response.status, 503);
});

test("AG-UI hydration reports when server persistence is disabled", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  process.env.COMPADRE_API_KEY = "test-key";
  delete process.env.COMPADRE_THREAD_PERSISTENCE_ENABLED;
  const response = await aguiRoutes.request("/ag-ui?threadId=thread-1", {
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "thread persistence is not enabled",
  });
});

test("AG-UI route rejects unauthorized requests before parsing input", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  process.env.COMPADRE_API_KEY = "test-key";
  const response = await aguiRoutes.request("/ag-ui", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-key" },
  });
  assert.equal(response.status, 401);
});

test("AG-UI route returns 400 for a malformed protocol request", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  process.env.COMPADRE_API_KEY = "test-key";
  const response = await aguiRoutes.request("/ag-ui", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ threadId: "thread-without-required-fields" }),
  });
  assert.equal(response.status, 400);
});

test("AG-UI route rejects an unknown harness provider", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  process.env.COMPADRE_API_KEY = "test-key";
  const response = await aguiRoutes.request("/ag-ui", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "message-1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: { provider: "unknown" },
      state: {},
    }),
  });
  assert.equal(response.status, 400);
});

test("AG-UI route rejects an unknown agent profile", async () => {
  process.env.COMPADRE_TANSTACK_AI_ENABLED = "true";
  process.env.COMPADRE_API_KEY = "test-key";
  const response = await aguiRoutes.request("/ag-ui", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "message-1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: { profile: "unknown" },
      state: {},
    }),
  });
  assert.equal(response.status, 400);
});
