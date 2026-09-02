import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { webhookRoutes } from "./webhook.js";

const originalApiKey = process.env.COMPADRE_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.COMPADRE_API_KEY;
  else process.env.COMPADRE_API_KEY = originalApiKey;
});

test("webhook route fails closed when the API key is missing", async () => {
  delete process.env.COMPADRE_API_KEY;

  const response = await webhookRoutes.request("/webhook/datadog", {
    method: "POST",
  });

  assert.equal(response.status, 503);
});

test("webhook route rejects unauthenticated payloads before parsing them", async () => {
  process.env.COMPADRE_API_KEY = "test-key";

  const response = await webhookRoutes.request("/webhook/datadog", {
    method: "POST",
  });

  assert.equal(response.status, 401);
});
