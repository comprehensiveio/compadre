import * as NodeBuffer from "node:buffer";
import * as NodeVM from "node:vm";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  createPreviewHtmlInjector,
  PreviewBrowserObservation,
  PREVIEW_TELEMETRY_TAG,
  previewTelemetryScript,
} from "./CompadrePreviewTelemetry.ts";

const decodeObservation = Schema.decodeUnknownSync(PreviewBrowserObservation);

function inject(chunks: Uint8Array[]) {
  const injector = createPreviewHtmlInjector();
  return NodeBuffer.Buffer.concat([
    ...chunks.flatMap((chunk) => injector.push(chunk)),
    ...injector.finish(),
  ]).toString();
}

describe("preview telemetry injection", () => {
  it("preserves the doctype and multibyte content at every chunk boundary", () => {
    const html =
      '<!doctype html><html lang="en"><head data-title="é"><title>🌱</title></head><body>hello</body></html>';
    const source = NodeBuffer.Buffer.from(html);
    for (let i = 0; i <= source.length; i++) {
      expect(inject([source.subarray(0, i), source.subarray(i)])).toBe(
        html.replace('<head data-title="é">', `<head data-title="é">${PREVIEW_TELEMETRY_TAG}`),
      );
    }
  });
  it("passes through headless or unusually large prefixes without unbounded buffering", () => {
    expect(inject([NodeBuffer.Buffer.from("not html")])).toBe("not html");
    const source = " ".repeat(65_537) + "<head>";
    expect(inject([NodeBuffer.Buffer.from(source)])).toBe(source);
  });
  it("releases the first chunk as soon as the head arrives", () => {
    const injector = createPreviewHtmlInjector();
    expect(
      NodeBuffer.Buffer.concat(
        injector.push(NodeBuffer.Buffer.from("<!doctype html><head>")),
      ).toString(),
    ).toContain(PREVIEW_TELEMETRY_TAG);
    expect(injector.push(NodeBuffer.Buffer.from("next chunk"))).toEqual([
      NodeBuffer.Buffer.from("next chunk"),
    ]);
  });
});

// Run the actual shipped script without a browser, app server, or network.
function browserHarness(stored?: string) {
  let wallTime = Date.now();
  const events = new Map<string, Array<(event?: unknown) => void>>();
  const reports: Blob[] = [];
  const timers: Array<() => void> = [];
  const storage = new Map(stored ? [["compadre.preview.observation.v1", stored]] : []);
  let resourceCallback: (list: { getEntries(): unknown[] }) => void = () => {};
  const on = (name: string, callback: (event?: unknown) => void) =>
    events.set(name, [...(events.get(name) ?? []), callback]);
  const document = {
    visibilityState: "visible",
    wasDiscarded: false,
    querySelector: () => null,
    addEventListener: on,
  };
  NodeVM.runInNewContext(previewTelemetryScript, {
    window: {},
    document,
    location: {
      href: "https://preview.example/company?secret=never-log",
      origin: "https://preview.example",
    },
    crypto: { randomUUID: () => "test-id" },
    Blob,
    URL,
    Date: { now: () => wallTime },
    performance: {
      now: () => 500,
      getEntriesByType: () => [{ type: "reload", responseStart: 100 }],
    },
    navigator: { sendBeacon: (_url: string, body: Blob) => reports.push(body) },
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: on,
    setTimeout: (callback: () => void) => callback(),
    setInterval: (callback: () => void) => timers.push(callback),
    PerformanceObserver: class {
      constructor(callback: typeof resourceCallback) {
        resourceCallback = callback;
      }
      observe() {}
    },
  });
  return {
    advanceWallTime: (ms: number) => {
      wallTime += ms;
    },
    document,
    timers,
    reports,
    storage,
    emit: (name: string, event?: unknown) => events.get(name)?.forEach((fn) => fn(event)),
    resource: (entry: unknown) => resourceCallback({ getEntries: () => [entry] }),
  };
}

it("reports app readiness and resource totals without URLs or application data", async () => {
  const browser = browserHarness();
  browser.resource({
    name: "https://preview.example/api/data?secret=never-log",
    duration: 120,
    transferSize: 100,
  });
  browser.resource({
    name: "https://preview.example/.compadre/preview/telemetry",
    duration: 900,
    transferSize: 999,
  });
  browser.emit("app-data-ready");
  const body = await browser.reports.at(-1)!.text();
  expect(body).not.toContain("never-log");
  const data = decodeObservation(JSON.parse(body));
  expect(data.kind).toBe("app_ready");
  expect(data.apiCount).toBe(1);
  expect(data.resourceDurationMs).toBe(120);
  expect(data.resourceCount).toBe(1);
});

it("distinguishes visible tabs from real interaction and suppresses hidden heartbeats", async () => {
  const browser = browserHarness();
  browser.document.visibilityState = "hidden";
  browser.timers[0]!();
  expect(browser.reports).toHaveLength(1);
  browser.document.visibilityState = "visible";
  browser.emit("pointerdown", { isTrusted: true });
  browser.timers[0]!();
  expect(JSON.parse(await browser.reports.at(-1)!.text())).toMatchObject({
    kind: "heartbeat",
    interactionCount: 1,
    visible: true,
  });
});

it("carries activation reload context to the next page without reusing an old reason", async () => {
  const browser = browserHarness();
  browser.emit("compadre-preview-ready");
  const next = browserHarness(browser.storage.get("compadre.preview.observation.v1"));
  expect(JSON.parse(await next.reports[0]!.text())).toMatchObject({
    previousReason: "activation_ready",
    previousPageId: "test-id",
  });
  next.advanceWallTime(180_000);
  next.emit("app-data-ready");
  expect(JSON.parse(await next.reports.at(-1)!.text())).toMatchObject({
    kind: "app_ready",
    previousReason: "activation_ready",
    previousPageId: "test-id",
  });
  const old = browserHarness(
    JSON.stringify({
      tabId: "old-tab",
      pageId: "old-page",
      reason: "vite_disconnect",
      reasonAt: 1,
      at: 1,
    }),
  );
  expect(JSON.parse(await old.reports[0]!.text()).previousReason).toBe("unknown");
});

it("rejects unbounded measurements and excludes unrecognized fields", async () => {
  const browser = browserHarness();
  const report = JSON.parse(await browser.reports[0]!.text());
  expect(() => decodeObservation({ ...report, elapsedMs: Infinity })).toThrow();
  const decoded = decodeObservation({ ...report, url: "secret" });
  expect(decoded).not.toHaveProperty("url");
});
