import { describe, expect, it, vi } from "vite-plus/test";

import {
  compadreOperationsConfiguration,
  fetchCompadreThreadOperations,
} from "./CompadreOperations.ts";

describe("CompadreOperations", () => {
  it("requires both controller URL and service token", () => {
    expect(compadreOperationsConfiguration({})).toBeNull();
    expect(
      compadreOperationsConfiguration({
        COMPADRE_CONTROLLER_URL: "https://controller.example",
        COMPADRE_API_KEY: "secret",
      }),
    ).toEqual({
      controllerUrl: new URL("https://controller.example"),
      serviceToken: "secret",
    });
  });

  it("authenticates the upstream request and validates its contract", async () => {
    const fetch = vi.fn(async (_url: URL, _init?: RequestInit) =>
      Response.json({
        generatedAt: "2026-08-31T17:00:00.000Z",
        thresholds: { attentionAfterMs: 600_000, stuckAfterMs: 1_800_000 },
        counts: { total: 0, working: 0, attention: 0, stuck: 0, containersRunning: 0 },
        threads: [],
      }),
    );
    const snapshot = await fetchCompadreThreadOperations({
      config: {
        controllerUrl: new URL("https://controller.example"),
        serviceToken: "secret",
      },
      fetch,
    });

    expect(snapshot.counts.total).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe("https://controller.example/internal/operations/threads");
    expect(init?.headers).toEqual({ authorization: "Bearer secret" });
  });
});
