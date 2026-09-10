import { z } from "zod";
import type { MetadataStore } from "./storage.js";
import type { T3Attachment, T3Client } from "./client.js";
import type { T3CommandClient } from "./gateway.js";

const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number(), type: z.enum(["image", "file"]) }).passthrough();
const NAMESPACE = "compadre.t3.native-attachments.v1";

/** Only identities are persisted here. The canonical attachment store owns the bytes. */
export async function copyNativeAttachments(input: {
  metadata: MetadataStore; worker: Pick<T3CommandClient, "readNativeAttachment">; central: T3Client; sourceThreadId: string;
  events: unknown[]; signal?: AbortSignal;
}): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const event of input.events) {
    const parsed = z.object({ type: z.literal("thread.message-sent"), payload: z.object({ attachments: z.array(attachmentSchema) }).passthrough() }).passthrough().safeParse(event);
    if (!parsed.success) { result.push(event); continue; }
    const attachments: T3Attachment[] = [];
    for (const source of parsed.data.payload.attachments) {
      const key = `${encodeURIComponent(input.sourceThreadId)}:${source.id}`;
      const existing = await input.metadata.get(NAMESPACE, key);
      if (existing) { attachments.push(attachmentSchema.parse(existing) as T3Attachment); continue; }
      if (!input.worker.readNativeAttachment) throw new Error("Worker cannot read native attachments");
      const bytes = await input.worker.readNativeAttachment(source.id, input.signal);
      if (bytes.byteLength !== source.sizeBytes) throw new Error("Native attachment size mismatch");
      const copied = await input.central.uploadAttachment({ name: source.name, mimeType: source.mimeType, bytes, signal: input.signal });
      if (!copied) throw new Error("Central server cannot store native attachments");
      await input.metadata.set(NAMESPACE, key, copied);
      attachments.push(copied);
    }
    result.push({ ...parsed.data, payload: { ...parsed.data.payload, attachments } });
  }
  return result;
}
