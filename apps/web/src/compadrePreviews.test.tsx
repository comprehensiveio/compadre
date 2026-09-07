import { afterEach, expect, it, vi } from "vite-plus/test";
import { COMPADRE_PREVIEW_FRESHNESS_MS } from "@t3tools/contracts";

vi.mock("./state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("./components/ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: "span",
}));

import { watchCompadrePreviews } from "./compadrePreviews";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", globalThis);
  const ready = {
    previews: [
      {
        threadId: "thread",
        url: "https://thread.dev.example",
        checkedAt: new Date().toISOString(),
      },
    ],
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(ready));
  vi.stubGlobal("fetch", fetch);
  const changes = vi.fn<(previews: ReadonlyMap<string, string>) => void>();
  return { document, fetch, changes };
}

it("shares a preview snapshot, hides it on outage, and recovers on the next refresh", async () => {
  const { fetch, changes } = setup();
  const stop = watchCompadrePreviews(changes);
  await vi.advanceTimersByTimeAsync(0);
  expect(changes.mock.lastCall?.[0].get("thread")).toBe("https://thread.dev.example/");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementationOnce(async () => new Response(null, { status: 502 }));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(changes.mock.lastCall?.[0].size).toBe(0);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(changes.mock.lastCall?.[0].size).toBe(1);
  stop();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("expires an observation even if a refresh hangs", async () => {
  const { fetch, changes } = setup();
  const stop = watchCompadrePreviews(changes);
  await vi.advanceTimersByTimeAsync(0);
  fetch.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(changes.mock.lastCall?.[0].size).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  stop();
});

it("keeps a fresh preview while hidden and refreshes without flickering on return", async () => {
  const { fetch, changes, document } = setup();
  const stop = watchCompadrePreviews(changes);
  await vi.advanceTimersByTimeAsync(0);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(changes.mock.lastCall?.[0].size).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(() => new Promise(() => {}));
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(changes.mock.lastCall?.[0].size).toBe(1);
  stop();
});

it("drops a preview that became stale while the tab was hidden", async () => {
  const { changes, document } = setup();
  const stop = watchCompadrePreviews(changes);
  await vi.advanceTimersByTimeAsync(0);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(COMPADRE_PREVIEW_FRESHNESS_MS);
  expect(changes.mock.lastCall?.[0].size).toBe(1);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(changes.mock.lastCall?.[0].size).toBe(0);
  stop();
});
