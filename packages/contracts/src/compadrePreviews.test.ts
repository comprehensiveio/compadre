import { expect, it } from "vite-plus/test";
import { freshCompadrePreviewUrl } from "./compadrePreviews.ts";

it("expires ready links and rejects invalid or unsafe readiness data", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const ready = {
    threadId: "thread",
    url: "https://thread.dev.example",
    checkedAt: "2026-09-07T12:00:00.000Z",
  };
  expect(freshCompadrePreviewUrl(ready, now)).toBe("https://thread.dev.example/");
  expect(freshCompadrePreviewUrl(ready, now + 89_999)).not.toBeNull();
  expect(freshCompadrePreviewUrl(ready, now + 90_000)).toBeNull();
  expect(freshCompadrePreviewUrl(ready, now - 1)).toBeNull();
  expect(freshCompadrePreviewUrl({ ...ready, checkedAt: "invalid" }, now)).toBeNull();
  for (const url of [
    "javascript:alert(1)",
    "http://example.com",
    "https://user:pass@example.com",
    "invalid",
  ]) {
    expect(freshCompadrePreviewUrl({ ...ready, url }, now)).toBeNull();
  }
});
