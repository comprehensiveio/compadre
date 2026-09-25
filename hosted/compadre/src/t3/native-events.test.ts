import assert from "node:assert/strict";
import test from "node:test";
import { NativeThreadDelivery, NativeDeliveryRejectedError, readNativeEventPage, nativeDeliverySink, type NativeDeliveryState } from "./native-events.js";
import { InMemoryLockStore, type MetadataStore } from "./storage.js";

const offset = (value: number) => String(value).padStart(20, "0");
const initial: NativeDeliveryState = {
  version: 1, canonicalThreadId: "central", sourceThreadId: "worker", sandboxId: "sandbox-1", epoch: 1,
  offset: offset(7), startOffset: offset(7), checkpointOffset: 0,
};

test("private delivery preserves authentication and the complete event payload", async () => {
  const events = [{ output: "<script>diagnostic</script> SELECT * FROM example;".repeat(600) }];
  const requests: string[] = [];
  const sink = nativeDeliverySink({ baseUrl: "https://public.example", internalHost: "central.internal", apiKey: "controller-secret",
    fetch: async (url, init) => {
      requests.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer controller-secret");
      if (init?.method === "POST") assert.deepEqual(JSON.parse(String(init.body)).events, events);
      return new Response("{}", { headers: { "x-compadre-native-event-version": "1" } });
    },
  });
  await sink.bind(initial); await sink.append(initial, events); await sink.close(initial);
  assert.deepEqual(requests, Array(3).fill("http://central.internal:10000/api/compadre/native-events?threadId=central"));
});

test("local private delivery accepts an explicit central port", async () => {
  const sink = nativeDeliverySink({ baseUrl: "https://unused.example", internalHost: "127.0.0.1:34567", apiKey: "test",
    fetch: async (url) => {
      assert.equal(new URL(String(url)).origin, "http://127.0.0.1:34567");
      return new Response("{}", { headers: { "x-compadre-native-event-version": "1" } });
    },
  });
  await sink.append(initial, []);
});

test("rejection diagnostics identify the edge without exposing response bodies or arbitrary headers", async () => {
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "secret", fetch: async () => new Response("private tool output", {
    status: 403, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc-EWR", "set-cookie": "credential=secret" },
  }) });
  await assert.rejects(sink.append(initial, []), (error: unknown) => {
    assert.ok(error instanceof NativeDeliveryRejectedError);
    assert.match(error.message, /server=cloudflare; cf-ray=abc-EWR/);
    assert.ok(!error.message.includes("private tool output") && !error.message.includes("secret"));
    return true;
  });
});

test("permanent HTTP rejections stop retries while overload and server errors remain retryable", async () => {
  for (const status of [400, 401, 403, 409, 413, 429, 503]) {
    const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "secret", fetch: async () => new Response("private response", { status }) });
    await assert.rejects(sink.append(initial, []), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof NativeDeliveryRejectedError, status < 429);
      assert.ok(!error.message.includes("private response"));
      return true;
    });
  }
});

test("blocking delivery preserves its cursor even if central is down, and replay clears the block", async () => {
  const store = metadata();
  let unavailable = true;
  const delivery = new NativeThreadDelivery(store, new InMemoryLockStore(), {
    async bind() {}, async append() {},
    async close(_state, _signal, reason) { assert.equal(reason, "Delivery blocked"); if (unavailable) throw new Error("central down"); },
  });
  await delivery.bind(initial);
  await assert.rejects(delivery.block("central", 1, "Delivery blocked"), /central down/);
  assert.equal((await delivery.get("central"))?.offset, initial.offset);
  assert.equal((await delivery.get("central"))?.blocked?.reason, "Delivery blocked");
  unavailable = false;
  await delivery.block("central", 1, "Delivery blocked");
  await delivery.deliverPage({ threadId: "central", epoch: 1, read: async () => ({ events: [{}], nextOffset: offset(8), upToDate: true }) });
  assert.equal((await delivery.get("central"))?.blocked, undefined);
  await delivery.bind({ ...initial, epoch: 2, sandboxId: "replacement" });
  await delivery.block("central", 1, "Delivery blocked");
  assert.equal((await delivery.get("central"))?.blocked, undefined);
});
function metadata(): MetadataStore {
  const values = new Map<string, unknown>();
  return { get: async (ns, key) => values.get(`${ns}:${key}`) ?? null,
    set: async (ns, key, value) => { values.set(`${ns}:${key}`, structuredClone(value)); },
    delete: async (ns, key) => { values.delete(`${ns}:${key}`); } };
}

test("restarts from the last acknowledged cursor and never resets it on an equal claim", async () => {
  const store = metadata(); const locks = new InMemoryLockStore();
  let loseAcknowledgement = true;
  const received: unknown[][] = [];
  const sink = { bind: async () => {}, append: async (_state: NativeDeliveryState, events: unknown[]) => {
    received.push(events);
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("lost acknowledgement"); }
  } };
  let delivery = new NativeThreadDelivery(store, locks, sink);
  await delivery.bind(initial);
  const page = { events: [{ eventId: "event-8" }], nextOffset: offset(8), upToDate: true };
  const readOffsets: string[] = [];
  const input = { threadId: "central", epoch: 1, read: async (state: NativeDeliveryState) => {
    readOffsets.push(state.offset); return page;
  } };
  await assert.rejects(delivery.deliverPage(input), /lost acknowledgement/);
  assert.equal((await delivery.get("central"))?.offset, offset(7));
  delivery = new NativeThreadDelivery(store, locks, sink);
  await delivery.deliverPage(input);
  assert.deepEqual(readOffsets, [offset(7), offset(7)]);
  assert.deepEqual(received[0], received[1]);
  await delivery.bind(initial);
  assert.equal((await delivery.get("central"))?.offset, offset(8));
  await delivery.bind({ ...initial, epoch: 2, sandboxId: "sandbox-2" });
  await assert.rejects(delivery.deliverPage(input), /superseded/);
});

test("keeps the adoption boundary fixed when skipped source events advance the cursor", async () => {
  const bound: string[] = [];
  const delivery = new NativeThreadDelivery(metadata(), new InMemoryLockStore(), {
    bind: async (state) => { bound.push(state.startOffset); }, append: async () => { throw new Error("empty pages do not append"); },
  });
  await delivery.bind(initial);
  for (const next of [8, 9]) await delivery.deliverPage({ threadId: "central", epoch: 1,
    read: async () => ({ events: [], nextOffset: offset(next), upToDate: true }),
  });
  assert.deepEqual(bound, [offset(7), offset(7), offset(7)]);
  assert.equal((await delivery.get("central"))?.offset, offset(9));
});

test("validates the worker version and offset before acknowledging any data", async () => {
  const calls: URL[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(new URL(String(url)));
    return new Response(JSON.stringify([{ eventId: "event-8" }]), { headers: {
      "x-compadre-native-event-version": "1", "stream-next-offset": offset(8), "stream-up-to-date": "true",
    } });
  };
  const input = { baseUrl: "https://worker.example", accessToken: "scoped-worker-token", threadId: "worker", offset: offset(7), live: true, fetch: fakeFetch };
  assert.equal((await readNativeEventPage(input)).nextOffset, offset(8));
  assert.equal(calls[0]?.searchParams.get("live"), "long-poll");
  await assert.rejects(readNativeEventPage({ ...input, offset: offset(9) }), /backwards/);
  await assert.rejects(readNativeEventPage({ ...input, fetch: async () => new Response("[]") }), /version 1/);
});

test("central binding and append use distinct methods and require a versioned acknowledgement", async () => {
  const calls: { method: string | undefined; body: unknown }[] = [];
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "controller-key", fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer controller-key");
    calls.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { headers: { "x-compadre-native-event-version": "1" } });
  } });
  await sink.bind({ ...initial, offset: offset(10) });
  await sink.append(initial, [{ eventId: "new" }]);
  assert.equal(calls[0]?.method, "PUT");
  assert.deepEqual(calls[0]?.body, { sourceThreadId: "worker", epoch: 1, sourceSequence: 7, checkpointOffset: 0 });
  assert.equal(calls[1]?.method, "POST");
});

test("a pending long poll does not block a replacement claim or deliver its stale page", async () => {
  const appended: unknown[][] = [];
  const delivery = new NativeThreadDelivery(metadata(), new InMemoryLockStore(), {
    bind: async () => {}, append: async (_state, events) => { appended.push(events); },
  });
  await delivery.bind(initial);
  let resolvePage!: (value: { events: unknown[]; nextOffset: string; upToDate: boolean }) => void;
  const pagePromise = new Promise<{ events: unknown[]; nextOffset: string; upToDate: boolean }>((resolve) => { resolvePage = resolve; });
  let resolveStarted!: () => void;
  const startedPromise = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const first = delivery.deliverPage({ threadId: "central", epoch: 1, read: async () => { resolveStarted(); return pagePromise; } });
  await startedPromise;
  await delivery.bind({ ...initial, epoch: 2, sandboxId: "sandbox-2" });
  resolvePage({ events: [{ eventId: "old-worker-event" }], nextOffset: offset(8), upToDate: true });
  await assert.rejects(first, /superseded/);
  assert.deepEqual(appended, []);
  assert.equal((await delivery.get("central"))?.epoch, 2);
});

const toolEvent = (id: string, output: string) => ({
  eventId: id, type: "thread.activity-appended", sequence: 8,
  payload: { threadId: "worker", activity: {
    id, turnId: "turn", kind: "tool.completed", tone: "tool", summary: "compadre · s3_get_object",
    payload: { itemType: "mcp_tool_call", toolCallId: id, status: "completed", title: "compadre · s3_get_object",
      data: { item: { tool: "s3_get_object", result: { content: output } } } },
  } },
});
const nativeOk = () => new Response("{}", { headers: { "x-compadre-native-event-version": "1" } });

test("small events are bounded by central dispatch work and replay safely after a timeout", async () => {
  const events = Array.from({ length: 128 }, (_, i) => ({ eventId: `event-${i}`, sequence: i + 8 }));
  const committed = new Set<string>();
  const batches: unknown[][] = [];
  let loseAcknowledgement = true;
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    if (init?.method !== "POST") return nativeOk();
    const batch = JSON.parse(String(init.body)).events as typeof events;
    batches.push(batch);
    // Model sequential central dispatch exhausting the request budget even
    // though the entire page is far below the byte limit.
    if (batch.length > 8) throw new DOMException("Central apply deadline", "TimeoutError");
    for (const event of batch) committed.add(event.eventId);
    if (loseAcknowledgement && batches.length === 2) {
      loseAcknowledgement = false;
      throw new DOMException("Acknowledgement lost", "TimeoutError");
    }
    return nativeOk();
  } });
  const store = metadata();
  const locks = new InMemoryLockStore();
  let delivery = new NativeThreadDelivery(store, locks, sink);
  await delivery.bind(initial);
  const input = { threadId: "central", epoch: 1, read: async () => ({ events, nextOffset: offset(135), upToDate: true }) };
  await assert.rejects(delivery.deliverPage(input), /Acknowledgement lost/);
  assert.equal((await delivery.get("central"))?.offset, initial.offset);
  delivery = new NativeThreadDelivery(store, locks, sink);
  await delivery.deliverPage(input);
  assert.deepEqual(batches.slice(0, 2), batches.slice(2, 4));
  assert.deepEqual(batches.slice(2).flat(), events);
  assert.equal(committed.size, events.length);
  assert.equal((await delivery.get("central"))?.offset, offset(135));
});

test("large journal pages split by serialized UTF-8 bytes without changing events or order", async () => {
  const events = Array.from({ length: 24 }, (_, i) => toolEvent(`event-${i}`, '🌍"\\\n'.repeat(120_000)));
  const bodies: string[] = [];
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    bodies.push(String(init?.body)); return nativeOk();
  } });
  await sink.append(initial, events);
  assert.ok(bodies.length > 1);
  for (const body of bodies) {
    assert.ok(Buffer.byteLength(body) <= 4 * 1024 * 1024);
    assert.equal(JSON.parse(body).sourceThreadId, "worker");
  }
  assert.deepEqual(bodies.flatMap((body) => JSON.parse(body).events), events);
});

test("single events above the batch target but within central's limit replay unchanged", async () => {
  const event = toolEvent("large-but-valid", "x".repeat(5 * 1024 * 1024));
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).events, [event]); return nativeOk();
  } });
  await sink.append(initial, [event]);
});

test("oversized tools retain identity/status/name and deterministic omission evidence without mutating the journal", async () => {
  const event = toolEvent("oversized", "sensitive-output".repeat(650_000));
  const original = JSON.stringify(event);
  const bodies: string[] = [];
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    bodies.push(String(init?.body)); return nativeOk();
  } });
  await sink.append(initial, [event]); await sink.append(initial, [event]);
  assert.equal(bodies[0], bodies[1]);
  await sink.append({ ...initial, epoch: 100 }, [event]);
  assert.deepEqual(JSON.parse(bodies[0]!).events, JSON.parse(bodies[2]!).events);
  assert.equal(JSON.stringify(event), original);
  assert.ok(!bodies[0]!.includes("sensitive-output"));
  const compacted = JSON.parse(bodies[0]!).events[0];
  assert.equal(compacted.eventId, event.eventId);
  assert.equal(compacted.payload.activity.id, event.payload.activity.id);
  assert.equal(compacted.payload.activity.summary, event.payload.activity.summary);
  const details = compacted.payload.activity.payload;
  assert.equal(details.toolCallId, "oversized");
  assert.equal(details.status, "completed");
  assert.equal(details.title, event.payload.activity.payload.title);
  assert.match(details.detail, /Tool details omitted/);
  assert.equal(details.detailsOmitted.originalEventBytes, Buffer.byteLength(original));
  assert.match(details.detailsOmitted.sha256, /^[a-f0-9]{64}$/);
});

test("oversized messages and interactive requests fail preflight without sending part of the page", async () => {
  let calls = 0;
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async () => { calls++; return nativeOk(); } });
  const big = "x".repeat(9 * 1024 * 1024);
  const interactive = toolEvent("interactive", big);
  Object.assign(interactive.payload.activity.payload, { requestId: "approval" });
  for (const event of [{ type: "thread.message-sent", payload: { text: big } }, interactive]) {
    await assert.rejects(sink.append(initial, [toolEvent("small", "ok"), event]), /central body limit/);
  }
  assert.equal(calls, 0);
});

test("losing a later batch acknowledgement preserves the page cursor and replays identical batches", async () => {
  const store = metadata();
  const bodies: string[] = [];
  let fail = true;
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    if (init?.method === "POST") {
      bodies.push(String(init.body));
      if (fail && bodies.length === 2) throw new Error("ack lost");
    }
    return nativeOk();
  } });
  const delivery = new NativeThreadDelivery(store, new InMemoryLockStore(), sink);
  await delivery.bind(initial);
  const events = Array.from({ length: 3 }, (_, i) => toolEvent(`event-${i}`, "x".repeat(3 * 1024 * 1024)));
  const input = { threadId: "central", epoch: 1, read: async () => ({ events, nextOffset: offset(10), upToDate: true }) };
  await assert.rejects(delivery.deliverPage(input), /ack lost/);
  assert.equal((await delivery.get("central"))?.offset, initial.offset);
  fail = false;
  await delivery.deliverPage(input);
  assert.equal((await delivery.get("central"))?.offset, offset(10));
  assert.equal(bodies.length, 5);
  assert.deepEqual(bodies.slice(0, 2), bodies.slice(2, 4));
});

test("the hard limit counts envelope bytes and preserves an exactly fitting event", async () => {
  const limit = 8 * 1024 * 1024;
  const event = toolEvent("boundary", "");
  const envelope = (events: unknown[]) => JSON.stringify({ version: 1, sourceThreadId: initial.sourceThreadId, epoch: initial.epoch, events });
  event.payload.activity.payload.data.item.result.content = "x".repeat(limit - Buffer.byteLength(envelope([event])));
  const bodies: string[] = [];
  const sink = nativeDeliverySink({ baseUrl: "https://central.example", apiKey: "test", fetch: async (_url, init) => {
    bodies.push(String(init?.body)); return nativeOk();
  } });
  await sink.append(initial, [event]);
  assert.equal(Buffer.byteLength(bodies[0]!), limit);
  assert.deepEqual(JSON.parse(bodies[0]!).events, [event]);
  event.payload.activity.payload.data.item.result.content += "x";
  // An event that once fit must not change just because the envelope grew.
  await assert.rejects(sink.append(initial, [event]), /central body limit/);
  event.payload.activity.payload.data.item.result.content += "x".repeat(1024);
  Object.assign(event.payload.activity.payload.data.item, { status: "failed" });
  await sink.append(initial, [event]);
  const details = JSON.parse(bodies[1]!).events[0].payload.activity.payload;
  assert.equal(details.status, "failed");
  assert.equal(details.detailsOmitted.originalEventBytes, Buffer.byteLength(JSON.stringify(event)));
});
