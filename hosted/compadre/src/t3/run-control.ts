import { z } from "zod";
import type { LockStore, MetadataStore } from "./storage.js";

const CONTROL_NAMESPACE = "compadre.t3.run-controls.v1";

export const nativeT3SteeringInputSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(100_000),
});

export type NativeT3SteeringInput = z.infer<
  typeof nativeT3SteeringInputSchema
>;

export interface NativeT3SteeringEntry extends NativeT3SteeringInput {
  state: "pending" | "delivered" | "rejected";
}

const controlStateSchema = z.object({
  entries: z.array(
    nativeT3SteeringInputSchema.extend({
      state: z.enum(["pending", "delivered", "rejected"]),
    }),
  ),
});

/** Durable, ordered mailbox for steering that can arrive during provisioning. */
export class NativeT3RunControlStore {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly locks: LockStore,
  ) {}

  private key(runId: string): string {
    return `compadre:native-t3-run-controls:${runId}`;
  }

  private async read(runId: string): Promise<NativeT3SteeringEntry[]> {
    const value = await this.metadata.get(CONTROL_NAMESPACE, runId);
    if (value === null) return [];
    return controlStateSchema.parse(value).entries;
  }

  async enqueue(
    runId: string,
    input: NativeT3SteeringInput,
  ): Promise<NativeT3SteeringEntry> {
    return this.locks.withLock(this.key(runId), async (signal) => {
      if (signal.aborted) throw signal.reason;
      const entries = await this.read(runId);
      const existing = entries.find((entry) => entry.id === input.id);
      if (existing) {
        if (existing.text !== input.text) {
          throw new Error(
            `Native T3 steering id ${input.id} was reused with different text`,
          );
        }
        return existing;
      }
      const entry: NativeT3SteeringEntry = { ...input, state: "pending" };
      await this.metadata.set(CONTROL_NAMESPACE, runId, {
        entries: [...entries, entry],
      });
      return entry;
    });
  }

  async pending(runId: string): Promise<NativeT3SteeringEntry[]> {
    return (await this.read(runId)).filter(
      (entry) => entry.state === "pending",
    );
  }

  async entry(
    runId: string,
    id: string,
  ): Promise<NativeT3SteeringEntry | null> {
    return (await this.read(runId)).find((entry) => entry.id === id) ?? null;
  }

  async settle(
    runId: string,
    id: string,
    state: "delivered" | "rejected",
  ): Promise<void> {
    await this.locks.withLock(this.key(runId), async (signal) => {
      if (signal.aborted) throw signal.reason;
      const entries = await this.read(runId);
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0 || entries[index]?.state === state) return;
      const current = entries[index]!;
      entries[index] = { ...current, state };
      await this.metadata.set(CONTROL_NAMESPACE, runId, { entries });
    });
  }

  withDeliveryLock<T>(
    runId: string,
    id: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.locks.withLock(`${this.key(runId)}:${id}`, operation);
  }
}

export function appendSetupSteering(
  prompt: string,
  entries: ReadonlyArray<Pick<NativeT3SteeringEntry, "text">>,
): string {
  return [
    prompt,
    ...entries.map(
      ({ text }) => `Follow-up instruction received during setup:\n${text}`,
    ),
  ].join("\n\n");
}
