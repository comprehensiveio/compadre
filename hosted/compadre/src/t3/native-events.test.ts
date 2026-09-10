import assert from "node:assert/strict";
import test from "node:test";
import { NativeThreadDelivery, readNativeEventPage, nativeDeliverySink, type NativeDeliveryState } from "./native-events.js";
import { InMemoryLockStore, type MetadataStore } from "./storage.js";

const offset = (value: number) => String(value).padStart(20, "0");
const initial: NativeDeliveryState = {
  version: 1, canonicalThreadId: "central", sourceThreadId: "worker", sandboxId: "sandbox-1", epoch: 1,
  offset: offset(7), startOffset: offset(7), checkpointOffset: 0,
};
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
