import { createHash } from "node:crypto";
import type { NativeDeliveryState } from "./native-events.js";

const TARGET_BYTES = 4 * 1024 * 1024;
// Matches central's MaxBodySize. Keep events that could already have been
// accepted unchanged: their immutable IDs must also replay identical payloads.
const MAX_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function omitToolDetails(event: unknown, serialized: string): unknown {
  const source = record(event);
  const payload = record(source?.payload);
  const activity = record(payload?.activity);
  const details = record(activity?.payload);
  if (source?.type !== "thread.activity-appended" || !activity || !details ||
      !["tool.started", "tool.updated", "tool.completed", "tool.progress"].includes(String(activity.kind)) ||
      details.requestId !== undefined) return event;
  const originalEventBytes = Buffer.byteLength(serialized);
  const notice = `Tool details omitted from central delivery (${originalEventBytes} bytes); original event retained in the worker journal.`;
  // Keep identity, lifecycle and display metadata; never copy arbitrary output
  // into a preview. Approval/question activities are not eligible for omission.
  const retained = Object.fromEntries([
    "itemType", "toolCallId", "status", "title", "toolName", "toolSurface", "toolIcon", "toolSource", "agentId", "parentToolUseId",
  ].filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
  const item = record(record(details.data)?.item);
  // Central's display projection normally performs this normalization from
  // provider data; retain failures even when that large data is omitted.
  if (retained.status === "completed" && (item?.status === "failed" || item?.status === "declined")) {
    retained.status = item.status;
  }
  return { ...source, payload: { ...payload, activity: { ...activity,
    payload: { ...retained, detail: notice, detailsOmitted: {
      reason: "native-event-body-limit", originalEventBytes,
      sha256: createHash("sha256").update(serialized).digest("hex"),
    } },
  } } };
}

/** Preflight the entire page, including JSON escaping/envelope bytes, before any POST. */
export function nativeEventBodies(state: NativeDeliveryState, events: unknown[]): string[] {
  if (events.length > 128) throw new Error("Invalid native event page: more than 128 events");
  const envelope = JSON.stringify({ version: 1, sourceThreadId: state.sourceThreadId, epoch: state.epoch, events: [] });
  const prefix = envelope.slice(0, -2);
  const envelopeBytes = Buffer.byteLength(envelope);
  const bodies: string[] = [];
  let batch: string[] = [];
  let bytes = envelopeBytes;
  for (const event of events) {
    let serialized = JSON.stringify(event);
    if (serialized === undefined) throw new Error("Invalid native event: not JSON serializable");
    // Decide omission from the event alone, not epoch/envelope length: restoring
    // the same journal under a new epoch must produce the same immutable event.
    if (Buffer.byteLength(serialized) > MAX_BYTES) {
      serialized = JSON.stringify(omitToolDetails(event, serialized));
    }
    const size = Buffer.byteLength(serialized);
    if (envelopeBytes + size > MAX_BYTES) {
      throw new Error(`Native event exceeds the ${MAX_BYTES}-byte central body limit after safe tool-detail omission (${size} event bytes)`);
    }
    if (batch.length && bytes + 1 + size > TARGET_BYTES) {
      bodies.push(`${prefix}${batch.join(",")}]}`);
      batch = []; bytes = envelopeBytes;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(serialized);
  }
  if (batch.length || !bodies.length) bodies.push(`${prefix}${batch.join(",")}]}`);
  return bodies;
}
