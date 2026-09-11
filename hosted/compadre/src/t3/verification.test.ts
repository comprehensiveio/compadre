import assert from "node:assert/strict";
import test from "node:test";
import { memoryPersistence } from "@tanstack/ai-persistence";
import { T3VerificationStore } from "./verification.js";
import { InMemoryLockStore } from "./storage.js";
import { NativeThreadDelivery, nativeDeliverySink, NativeDeliveryRejectedError, type NativeDeliveryState } from "./native-events.js";

test("faults are registered-canary-only, single-use, phase-scoped, and expire", async () => {
  let now = 1;
  const store = new T3VerificationStore(memoryPersistence().stores.metadata, new InMemoryLockStore(), () => now);
  await assert.rejects(store.arm("ordinary", "delivery-rejected"), /registered/);
  assert.equal(await store.consume("ordinary", "delivery"), null);
  await store.register("c0decafe-0000-4000-8000-000000000001");
  await store.arm("c0decafe-0000-4000-8000-000000000001", "request-persistence-failed");
  assert.equal(await store.consume("c0decafe-0000-4000-8000-000000000001", "delivery"), null);
  assert.deepEqual(await Promise.all([store.consume("c0decafe-0000-4000-8000-000000000001", "request"), store.consume("c0decafe-0000-4000-8000-000000000001", "request")]), ["request-persistence-failed", null]);
  await store.arm("c0decafe-0000-4000-8000-000000000001", "delivery-rejected");
  now += 10 * 60 * 1000;
  assert.equal(await store.consume("c0decafe-0000-4000-8000-000000000001", "delivery"), null);
});

test("live-verification hooks exercise real delivery rejection and lost-ack replay boundaries", async () => {
  const metadata = memoryPersistence().stores.metadata;
  const locks = new InMemoryLockStore();
  const store = new T3VerificationStore(metadata, locks);
  await store.register("c0decafe-0000-4000-8000-000000000001");
  const committed = new Set<string>();
  let requests = 0;
  const delivery = new NativeThreadDelivery(metadata, locks, nativeDeliverySink({
    baseUrl: "https://central.example", apiKey: "key", verificationFault: (thread) => store.consume(thread, "delivery"),
    fetch: async (_url, input) => {
      if (input?.method === "POST") { requests++; for (const event of JSON.parse(String(input.body)).events) committed.add(event.eventId); }
      return new Response("{}", { headers: { "x-compadre-native-event-version": "1" } });
    },
  }));
  const initial: NativeDeliveryState = { version: 1, canonicalThreadId: "c0decafe-0000-4000-8000-000000000001", sourceThreadId: "worker", sandboxId: "sandbox", epoch: 1,
    offset: "00000000000000000000", startOffset: "00000000000000000000", checkpointOffset: 0 };
  await delivery.bind(initial);
  const input = { threadId: "c0decafe-0000-4000-8000-000000000001", epoch: 1, read: async () => ({ events: [{ eventId: "event-1" }], nextOffset: "00000000000000000001", upToDate: true }) };
  await store.arm("c0decafe-0000-4000-8000-000000000001", "delivery-rejected");
  await assert.rejects(delivery.deliverPage(input), NativeDeliveryRejectedError);
  assert.equal(requests, 0);
  await store.arm("c0decafe-0000-4000-8000-000000000001", "delivery-ack-lost");
  await assert.rejects(delivery.deliverPage(input), /acknowledgement lost/);
  assert.equal((await delivery.get("c0decafe-0000-4000-8000-000000000001"))?.offset, initial.offset);
  await delivery.deliverPage(input);
  assert.equal(requests, 2);
  assert.equal(committed.size, 1);
  assert.equal((await delivery.get("c0decafe-0000-4000-8000-000000000001"))?.offset, "00000000000000000001");
});
