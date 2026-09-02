import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { TriggeredPromptStoreApi } from "../triggers/store.js";
import type {
  TriggeredPromptInput,
  TriggeredPromptRecord,
} from "../triggers/types.js";
import { createTriggeredPromptRoutes } from "./triggers.js";

function recordFromInput(
  id: string,
  input: TriggeredPromptInput,
): TriggeredPromptRecord {
  return {
    id,
    name: input.name,
    prompt: input.prompt,
    triggerType: input.triggerType,
    triggerConfig: {
      cronExpression: input.cronExpression,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    deliveryMode: input.deliveryMode,
    ...(input.slackChannelId ? { slackChannelId: input.slackChannelId } : {}),
    ...(input.targetThreadId ? { targetThreadId: input.targetThreadId } : {}),
    enabled: input.enabled,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function fakeStore(): TriggeredPromptStoreApi & { rows: Map<string, TriggeredPromptRecord> } {
  const rows = new Map<string, TriggeredPromptRecord>();
  let sequence = 0;
  return {
    rows,
    async create(input) {
      sequence += 1;
      const record = recordFromInput(`id-${sequence}`, input);
      rows.set(record.id, record);
      return record;
    },
    async update(id, input) {
      if (!rows.has(id)) return null;
      const record = recordFromInput(id, input);
      rows.set(id, record);
      return record;
    },
    async setEnabled(id, enabled) {
      const record = rows.get(id);
      if (!record) return null;
      const updated = { ...record, enabled };
      rows.set(id, updated);
      return updated;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async delete(id) {
      return rows.delete(id);
    },
    async recordFired() {},
  } as TriggeredPromptStoreApi & { rows: Map<string, TriggeredPromptRecord> };
}

function testApp(input: {
  store: TriggeredPromptStoreApi;
  syncError?: Error;
  synced: string[];
  deleted: string[];
  ran: string[];
}) {
  const app = new Hono();
  app.route(
    "/",
    createTriggeredPromptRoutes({
      enabled: () => true,
      getStore: async () => input.store,
      sync: {
        async syncTriggerSchedule(record) {
          if (input.syncError) throw input.syncError;
          input.synced.push(record.id);
        },
        async deleteTriggerSchedule(id) {
          input.deleted.push(id);
        },
        async runTriggerNow(id) {
          input.ran.push(id);
          return `wf-${id}`;
        },
      },
    }),
  );
  return app;
}

async function withApiKey(run: () => Promise<void>): Promise<void> {
  const previous = process.env.COMPADRE_API_KEY;
  process.env.COMPADRE_API_KEY = "test-key";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.COMPADRE_API_KEY;
    else process.env.COMPADRE_API_KEY = previous;
  }
}

const AUTH = { authorization: "Bearer test-key" };
const CREATE_BODY = {
  name: "Daily summary",
  prompt: "Summarize the day",
  cronExpression: "0 9 * * *",
  slackChannelId: "C0123456789",
};

test("triggered prompt routes require the service credential", async () => {
  await withApiKey(async () => {
    const app = testApp({ store: fakeStore(), synced: [], deleted: [], ran: [] });
    const unauthorized = await app.request("/triggers/api/prompts");
    assert.equal(unauthorized.status, 401);
    const authorized = await app.request("/triggers/api/prompts", {
      headers: AUTH,
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { prompts: [] });
  });
});

test("create persists the row, mirrors the schedule, and validates input", async () => {
  await withApiKey(async () => {
    const store = fakeStore();
    const synced: string[] = [];
    const app = testApp({ store, synced, deleted: [], ran: [] });

    const invalid = await app.request("/triggers/api/prompts", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ ...CREATE_BODY, cronExpression: "bad" }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { issues: string[] };
    assert.match(invalidBody.issues.join(";"), /cronExpression/);

    const created = await app.request("/triggers/api/prompts", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(CREATE_BODY),
    });
    assert.equal(created.status, 201);
    const { prompt } = (await created.json()) as { prompt: TriggeredPromptRecord };
    assert.equal(prompt.name, "Daily summary");
    assert.deepEqual(synced, [prompt.id]);
    assert.equal(store.rows.size, 1);
  });
});

test("a failed schedule sync rolls the created row back", async () => {
  await withApiKey(async () => {
    const store = fakeStore();
    const app = testApp({
      store,
      syncError: new Error("temporal unreachable"),
      synced: [],
      deleted: [],
      ran: [],
    });
    const created = await app.request("/triggers/api/prompts", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(CREATE_BODY),
    });
    assert.equal(created.status, 500);
    assert.equal(store.rows.size, 0);
  });
});

test("enable, run-now, and delete manage the schedule alongside the row", async () => {
  await withApiKey(async () => {
    const store = fakeStore();
    const synced: string[] = [];
    const deleted: string[] = [];
    const ran: string[] = [];
    const app = testApp({ store, synced, deleted, ran });
    const created = await app.request("/triggers/api/prompts", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(CREATE_BODY),
    });
    const { prompt } = (await created.json()) as { prompt: TriggeredPromptRecord };

    const paused = await app.request(
      `/triggers/api/prompts/${prompt.id}/enable`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    assert.equal(paused.status, 200);
    assert.equal(store.rows.get(prompt.id)?.enabled, false);

    const run = await app.request(`/triggers/api/prompts/${prompt.id}/run`, {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(run.status, 202);
    assert.deepEqual(await run.json(), { workflowId: `wf-${prompt.id}` });
    assert.deepEqual(ran, [prompt.id]);

    const removed = await app.request(
      `/triggers/api/prompts/${prompt.id}/delete`,
      { method: "POST", headers: AUTH },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(deleted, [prompt.id]);
    assert.equal(store.rows.size, 0);

    const missing = await app.request(
      `/triggers/api/prompts/${prompt.id}/run`,
      { method: "POST", headers: AUTH },
    );
    assert.equal(missing.status, 404);
  });
});

test("the routes stay dark when the hosted directory is disabled", async () => {
  const app = new Hono();
  app.route(
    "/",
    createTriggeredPromptRoutes({
      enabled: () => false,
      getStore: async () => fakeStore(),
      sync: {
        async syncTriggerSchedule() {},
        async deleteTriggerSchedule() {},
        async runTriggerNow() {
          return "wf";
        },
      },
    }),
  );
  const response = await app.request("/triggers/api/prompts");
  assert.equal(response.status, 404);
});
