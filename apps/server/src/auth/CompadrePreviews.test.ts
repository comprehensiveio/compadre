import { expect, it, vi } from "vite-plus/test";
import { fetchCompadreReadyPreviews } from "./CompadrePreviews.ts";

const config = {
  controllerUrl: new URL("https://controller.example"),
  serviceToken: "service-secret",
};

it("uses the preview-only endpoint with server credentials and validates its response", async () => {
  const snapshot = {
    previews: [
      { threadId: "thread", url: "https://thread.dev.example", checkedAt: "2026-09-07T12:00:00Z" },
    ],
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(snapshot));
  expect(await fetchCompadreReadyPreviews({ config, fetch })).toEqual(snapshot);
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    "https://controller.example/internal/previews/ready",
  );
  expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer service-secret" });
  fetch.mockResolvedValue(Response.json({ previews: [{ threadId: 5 }] }));
  await expect(fetchCompadreReadyPreviews({ config, fetch })).rejects.toThrow();
});

it("tolerates an older controller while rejecting unavailable readiness", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 404 }));
  expect(await fetchCompadreReadyPreviews({ config, fetch })).toEqual({ previews: [] });
  fetch.mockResolvedValue(new Response(null, { status: 502 }));
  await expect(fetchCompadreReadyPreviews({ config, fetch })).rejects.toThrow("502");
});
