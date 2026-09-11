import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  bounded: true,
  policies: [] as Array<{ retry?: { maximumAttempts?: number; nonRetryableErrorTypes?: string[] } }>,
  deliver: vi.fn(), block: vi.fn(), continueAsNew: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "wait" },
  CancellationScope: { nonCancellable: (fn: () => Promise<void>) => fn() },
  patched: () => h.bounded,
  proxyActivities: (options: typeof h.policies[number]) => {
    h.policies.push(options);
    return { deliverNativeThreadEventsActivity: h.deliver, blockNativeThreadDeliveryActivity: h.block };
  },
  continueAsNew: h.continueAsNew,
  defineUpdate: (name: string) => name,
  allHandlersFinished: vi.fn(), condition: vi.fn(), isCancellation: vi.fn(), log: {}, setHandler: vi.fn(),
}));
import { nativeThreadDeliveryWorkflow } from "./workflows.js";

beforeEach(() => {
  h.bounded = true; h.policies.length = 0;
  h.deliver.mockReset(); h.block.mockReset(); h.continueAsNew.mockReset();
});

it("bounds new delivery retries and surfaces exhaustion without consuming the cursor", async () => {
  const failure = new Error("delivery exhausted");
  h.deliver.mockRejectedValue(failure);
  const input = { threadId: "thread", epoch: 1 };
  await expect(nativeThreadDeliveryWorkflow(input)).rejects.toBe(failure);
  expect(h.policies[0]?.retry).toEqual({ initialInterval: "5 seconds", maximumInterval: "1 minute", maximumAttempts: 5,
    nonRetryableErrorTypes: ["NativeDeliveryRejectedError"] });
  expect(h.block).toHaveBeenCalledExactlyOnceWith(input);
  expect(h.policies[1]?.retry?.maximumAttempts).toBe(5);
  expect(h.continueAsNew).not.toHaveBeenCalled();
});

it("retains legacy scheduling commands for workflow replay", async () => {
  h.bounded = false; h.deliver.mockRejectedValue(new Error("legacy failure"));
  await expect(nativeThreadDeliveryWorkflow({ threadId: "thread", epoch: 1 })).rejects.toThrow("legacy failure");
  expect(h.policies[0]?.retry?.maximumAttempts).toBeUndefined();
  expect(h.block).not.toHaveBeenCalled();
});

it("healthy delivery continues its history without blocking", async () => {
  h.deliver.mockResolvedValue("continue");
  const input = { threadId: "thread", epoch: 1 };
  await nativeThreadDeliveryWorkflow(input);
  expect(h.continueAsNew).toHaveBeenCalledExactlyOnceWith(input);
  expect(h.block).not.toHaveBeenCalled();
});
