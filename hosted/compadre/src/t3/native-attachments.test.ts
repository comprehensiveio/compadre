import assert from "node:assert/strict";
import test from "node:test";
import { copyNativeAttachments } from "./native-attachments.js";
import { T3Client } from "./client.js";
import { memoryPersistence } from "@tanstack/ai-persistence";

test("native attachment delivery reuses a durable mapping on replay and preserves the native event", async () => {
  const persistence = memoryPersistence();
  const source = { type: "thread.message-sent", eventId: "event-1", payload: { threadId: "worker", text: "A file", attachments: [
    { id: "source-id", type: "file", name: "result.txt", mimeType: "text/plain", sizeBytes: 2 },
  ] } };
  const central = new T3Client("https://central.example", "unused");
  let uploads = 0;
  central.uploadAttachment = async () => { uploads++; return { id: "central-id", type: "file", name: "result.txt", mimeType: "text/plain", sizeBytes: 2 }; };
  const worker = { readNativeAttachment: async () => new Uint8Array([65, 66]) };
  const input = { metadata: persistence.stores.metadata, worker, central, sourceThreadId: "worker", events: [source] };
  const first = await copyNativeAttachments(input);
  assert.deepEqual(await copyNativeAttachments(input), first);
  assert.equal(uploads, 1);
  assert.deepEqual(first, [{ ...source, payload: { ...source.payload, attachments: [{ ...source.payload.attachments[0], id: "central-id" }] } }]);
  assert.equal(source.payload.attachments[0]?.id, "source-id");
});
