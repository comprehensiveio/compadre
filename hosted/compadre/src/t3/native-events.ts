import { z } from "zod";
import type { MetadataStore, LockStore } from "./storage.js";

export const NATIVE_EVENTS_PATH = "/api/compadre/native-events";
const offsetSchema = z.string().regex(/^\d{20}$/).refine((value) => Number.isSafeInteger(Number(value)));
const stateSchema = z.object({
  version: z.literal(1), canonicalThreadId: z.string().min(1), sourceThreadId: z.string().min(1),
  epoch: z.number().int().positive(), sandboxId: z.string().min(1),
  offset: offsetSchema, startOffset: offsetSchema, checkpointOffset: z.number().int().nonnegative(),
});
export type NativeDeliveryState = z.infer<typeof stateSchema>;
export interface NativeEventPage { events: unknown[]; nextOffset: string; upToDate: boolean; }
const NAMESPACE = "compadre.t3.native-delivery.v1";

/** The worker writes its own T3 journal; this is the Durable Streams read path. */
export async function readNativeEventPage(input: {
  baseUrl: string; accessToken: string; threadId: string; offset: string;
  live?: boolean; head?: boolean; signal?: AbortSignal; fetch?: typeof fetch;
}): Promise<NativeEventPage> {
  const url = new URL(NATIVE_EVENTS_PATH, input.baseUrl);
  url.searchParams.set("threadId", input.threadId);
  url.searchParams.set("offset", input.offset);
  if (input.live) url.searchParams.set("live", "long-poll");
  const response = await (input.fetch ?? fetch)(url, {
    method: input.head ? "HEAD" : "GET", headers: { authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]),
  });
  if (!response.ok) throw new Error(`Native event journal returned HTTP ${response.status}`);
  if (response.headers.get("x-compadre-native-event-version") !== "1") throw new Error("Worker does not support native event delivery version 1");
  const nextOffset = offsetSchema.parse(response.headers.get("stream-next-offset"));
  if (!input.head && input.offset !== "-1" && nextOffset < input.offset) throw new Error("Worker journal offset moved backwards; reconcile its generation");
  const events = input.head ? [] : z.array(z.unknown()).max(128).parse(await response.json());
  if (events.length > 0 && nextOffset === input.offset) throw new Error("Worker journal did not advance");
  return { events, nextOffset, upToDate: input.head || response.headers.get("stream-up-to-date") === "true" };
}

export class NativeThreadDelivery {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly locks: LockStore,
    private readonly sink: {
      bind(state: NativeDeliveryState, signal?: AbortSignal): Promise<void>;
      append(state: NativeDeliveryState, events: unknown[], signal?: AbortSignal): Promise<void>;
    },
  ) {}

  async get(threadId: string): Promise<NativeDeliveryState | null> {
    const value = await this.metadata.get(NAMESPACE, threadId);
    if (value === null) return null;
    // Invalid durable state must not put an adopted thread back on the legacy path.
    return stateSchema.parse(value);
  }

  /** Persist intent first: a crash before binding is retried at the same boundary. */
  async bind(state: NativeDeliveryState, signal?: AbortSignal): Promise<void> {
    await this.locks.withLock(`compadre:native-delivery:${state.canonicalThreadId}`, async (lockSignal) => {
      signal?.throwIfAborted(); lockSignal.throwIfAborted();
      const current = await this.get(state.canonicalThreadId);
      if (current && current.epoch > state.epoch) throw new Error("Native delivery claim was superseded");
      if (current && current.epoch === state.epoch) {
        if (current.sourceThreadId !== state.sourceThreadId || current.sandboxId !== state.sandboxId || current.startOffset !== state.startOffset ||
            current.checkpointOffset !== state.checkpointOffset) throw new Error("Conflicting native delivery claim");
        await this.sink.bind(current, signal);
        return;
      }
      await this.metadata.set(NAMESPACE, state.canonicalThreadId, stateSchema.parse(state));
      await this.sink.bind(state, signal);
    });
  }

  /** Central commands commit before the cursor; a lost acknowledgement replays safely. */
  async deliverPage(input: {
    threadId: string; epoch: number;
    read(state: NativeDeliveryState, signal: AbortSignal): Promise<NativeEventPage>;
    signal?: AbortSignal;
  }): Promise<NativeEventPage> {
    return this.locks.withLock(`compadre:native-delivery:${input.threadId}`, async (lockSignal) => {
      const signal = AbortSignal.any([lockSignal, ...(input.signal ? [input.signal] : [])]);
      signal.throwIfAborted();
      const state = await this.get(input.threadId);
      if (!state || state.epoch !== input.epoch) throw new Error("Native delivery claim was superseded");
      await this.sink.bind(state, signal);
      const page = await input.read(state, signal);
      offsetSchema.parse(page.nextOffset);
      if (page.nextOffset < state.offset) throw new Error("Native delivery cursor moved backwards");
      if (page.events.length > 128 || (page.events.length > 0 && page.nextOffset === state.offset)) throw new Error("Invalid native event page");
      if (page.events.length > 0) await this.sink.append(state, page.events, signal);
      signal.throwIfAborted();
      await this.metadata.set(NAMESPACE, input.threadId, { ...state, offset: page.nextOffset });
      return page;
    });
  }
}

export function nativeDeliverySink(input: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const request = async (state: NativeDeliveryState, method: "PUT" | "POST", body: unknown, signal?: AbortSignal) => {
    const url = new URL(NATIVE_EVENTS_PATH, input.baseUrl);
    url.searchParams.set("threadId", state.canonicalThreadId);
    const response = await (input.fetch ?? fetch)(url, {
      method, headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`Central native event ${method} returned HTTP ${response.status}`);
    if (response.headers.get("x-compadre-native-event-version") !== "1") throw new Error("Central native event protocol version mismatch");
    await response.arrayBuffer();
  };
  return {
    bind: (state: NativeDeliveryState, signal?: AbortSignal) => request(state, "PUT", {
      sourceThreadId: state.sourceThreadId, epoch: state.epoch,
      sourceSequence: Number(state.startOffset), checkpointOffset: state.checkpointOffset,
    }, signal),
    append: (state: NativeDeliveryState, events: unknown[], signal?: AbortSignal) => request(state, "POST", {
      version: 1, sourceThreadId: state.sourceThreadId, epoch: state.epoch, events,
    }, signal),
  };
}
