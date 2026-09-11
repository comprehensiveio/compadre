import { z } from "zod";
import type { LockStore, MetadataStore } from "./storage.js";

export const verificationScenario = z.enum(["none", "delivery-rejected", "delivery-transient", "delivery-ack-lost", "request-persistence-failed"]);
const namespace = "compadre.t3.verification.v1";
const recordSchema = z.object({
  createdAt: z.string(), scenario: verificationScenario, expiresAt: z.number(),
  remaining: z.number().int().nonnegative(), injectedAt: z.string().optional(),
});

/** One-shot, expiring faults on server-created canaries; never global faults. */
export class T3VerificationStore {
  constructor(private readonly metadata: MetadataStore, private readonly locks: LockStore, private readonly now = Date.now) {}

  async register(threadId: string): Promise<void> {
    if (!threadId.startsWith("verify-")) throw new Error("Verification thread id required");
    await this.metadata.set(namespace, threadId, { createdAt: new Date(this.now()).toISOString(), scenario: "none", remaining: 0, expiresAt: 0 });
  }

  async get(threadId: string) {
    if (!threadId.startsWith("verify-")) return null;
    const value = await this.metadata.get(namespace, threadId);
    return value === null ? null : recordSchema.parse(value);
  }

  async arm(threadId: string, scenario: z.infer<typeof verificationScenario>): Promise<void> {
    await this.locks.withLock(`compadre:verification:${threadId}`, async () => {
      const state = await this.get(threadId);
      if (!state) throw new Error("Not a registered verification thread");
      await this.metadata.set(namespace, threadId, {
        createdAt: state.createdAt, scenario, remaining: scenario === "none" ? 0 : 1,
        expiresAt: this.now() + 10 * 60 * 1000,
      });
    });
  }

  async consume(threadId: string, phase: "request" | "delivery") {
    if (!threadId.startsWith("verify-")) return null;
    return this.locks.withLock(`compadre:verification:${threadId}`, async () => {
      const state = await this.get(threadId);
      if (!state || !state.remaining || state.expiresAt <= this.now()) return null;
      if ((state.scenario === "request-persistence-failed") !== (phase === "request")) return null;
      await this.metadata.set(namespace, threadId, { ...state, remaining: 0, injectedAt: new Date(this.now()).toISOString() });
      console.info("[t3-verification] injected one-shot fault", { threadId, scenario: state.scenario });
      return state.scenario;
    });
  }
}
