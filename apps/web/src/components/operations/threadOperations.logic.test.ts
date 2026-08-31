import { describe, expect, it } from "vite-plus/test";
import type { CompadreThreadOperation } from "@t3tools/contracts";

import { filterThreadOperations, formatOperationsAge } from "./threadOperations.logic";

const base = {
  providerInstanceId: "codex",
  workerThreadId: "worker-thread",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  status: "ready",
  phase: "Idle",
  health: "healthy",
  healthReason: "No active turn",
  createdAt: "2026-08-31T12:00:00.000Z",
  updatedAt: "2026-08-31T12:00:00.000Z",
  container: { status: "stopped", sandboxId: "sandbox", generation: 1 },
} as const;

const threads: ReadonlyArray<CompadreThreadOperation> = [
  { ...base, canonicalThreadId: "one", title: "Healthy thread" },
  {
    ...base,
    canonicalThreadId: "two",
    title: "Database repair",
    status: "working",
    health: "stuck",
    phase: "Using Bash: pnpm test",
    healthReason: "No durable progress for 31 minutes",
  },
];

describe("thread operations list", () => {
  it("combines state filters with full-text search", () => {
    expect(
      filterThreadOperations(threads, "working", "pnpm").map((thread) => thread.title),
    ).toEqual(["Database repair"]);
    expect(filterThreadOperations(threads, "stuck", "database")).toHaveLength(1);
    expect(filterThreadOperations(threads, "healthy", "database")).toHaveLength(0);
  });

  it("formats compact ages", () => {
    const now = Date.parse("2026-08-31T13:01:30.000Z");
    expect(formatOperationsAge("2026-08-31T13:01:00.000Z", now)).toBe("30s ago");
    expect(formatOperationsAge("2026-08-31T12:00:00.000Z", now)).toBe("1h ago");
  });
});
