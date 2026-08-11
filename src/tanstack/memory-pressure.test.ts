import assert from "node:assert/strict";
import test from "node:test";
import {
  memoryPressureExceeded,
  startMemoryPressureWatchdog,
} from "./memory-pressure.js";

test("detects memory pressure at the configured container ratio", () => {
  assert.equal(
    memoryPressureExceeded(
      { usageBytes: 1_800, limitBytes: 2_000 },
      0.9,
    ),
    true,
  );
  assert.equal(
    memoryPressureExceeded(
      { usageBytes: 1_799, limitBytes: 2_000 },
      0.9,
    ),
    false,
  );
});

test("aborts an active run before the container limit is exhausted", async () => {
  const abortController = new AbortController();
  const stop = startMemoryPressureWatchdog(abortController, {
    intervalMs: 1,
    abortRatio: 0.95,
    readMemory: async () => ({ usageBytes: 1_950, limitBytes: 2_000 }),
    logger: { error() {} },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
      setTimeout(() => reject(new Error("watchdog did not abort")), 100);
    });
    assert.match(
      String(abortController.signal.reason),
      /service memory reached 98%/,
    );
  } finally {
    stop();
  }
});
