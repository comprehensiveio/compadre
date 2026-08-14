import assert from "node:assert/strict";
import test from "node:test";
import { promptRoutes } from "./prompt.js";

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("prompt route rejects invalid provider selection before starting a run", async () => {
  await withEnv(
    { COMPADRE_API_KEY: "test" },
    async () => {
      const response = await promptRoutes.request("/prompt", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hello", provider: "other" }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /provider/);
    }
  );
});

test("prompt route requires threadId instead of native sessionId", async () => {
  await withEnv(
    { COMPADRE_API_KEY: "test" },
    async () => {
      const response = await promptRoutes.request("/prompt", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hello", sessionId: "native-session" }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /threadId/);
    }
  );
});

test("prompt route rejects invalid explicit turn limits", async () => {
  await withEnv(
    { COMPADRE_API_KEY: "test" },
    async () => {
      const response = await promptRoutes.request("/prompt", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hello", maxTurns: 0 }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /maxTurns/);
    },
  );
});

test("prompt route fails closed when the API key is missing", async () => {
  await withEnv({ COMPADRE_API_KEY: undefined }, async () => {
    const response = await promptRoutes.request("/prompt", { method: "POST" });
    assert.equal(response.status, 503);
  });
});
