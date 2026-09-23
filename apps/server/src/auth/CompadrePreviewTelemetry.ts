import * as NodeBuffer from "node:buffer";
import * as Schema from "effect/Schema";

export const PREVIEW_TELEMETRY_PATH = "/.compadre/preview/telemetry";
export const PREVIEW_TELEMETRY_SCRIPT_PATH = `${PREVIEW_TELEMETRY_PATH}.js`;
export const PREVIEW_TELEMETRY_TAG = `<script src="${PREVIEW_TELEMETRY_SCRIPT_PATH}" data-compadre-telemetry></script>`;
const measure = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 }));
const identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,64}$/));
const reason = Schema.Literals([
  "unknown",
  "activation_ready",
  "vite_full_reload",
  "vite_disconnect",
  "vite_preload_error",
]);

// Only aggregate counters and fixed labels cross the preview boundary. Never
// accept URLs, request bodies, resource names, or application data in this log.
export const PreviewBrowserObservation = Schema.Struct({
  version: Schema.Literal(1),
  pageId: identifier,
  tabId: identifier,
  previousPageId: Schema.optional(identifier),
  kind: Schema.Literals([
    "navigation",
    "dom_ready",
    "window_load",
    "app_ready",
    "activation_ready",
    "activation_failed",
    "vite_disconnect",
    "vite_connect",
    "vite_full_reload",
    "vite_preload_error",
    "heartbeat",
    "pagehide",
    "visibility",
  ]),
  pageKind: Schema.Literals(["activation", "application"]),
  navigationType: Schema.Literals(["navigate", "reload", "back_forward", "prerender", "unknown"]),
  previousReason: reason,
  elapsedMs: measure,
  visible: Schema.Boolean,
  wasDiscarded: Schema.Boolean,
  interactionAgeMs: measure,
  interactionCount: measure,
  resourceCount: measure,
  resourceDurationMs: measure,
  resourceMaxMs: measure,
  apiCount: measure,
  apiDurationMs: measure,
  moduleCount: measure,
  transferredBytes: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }),
  ),
  ttfbMs: measure,
  domReadyMs: measure,
  loadMs: measure,
});

export const PreviewBrowserLog = Schema.fromJsonString(
  Schema.Struct({
    ...PreviewBrowserObservation.fields,
    event: Schema.Literal("compadre.preview.browser"),
    canonicalThreadId: Schema.String,
    actorId: Schema.String,
    receivedAt: Schema.Finite,
  }),
);

/** Insert after the opening head while preserving streaming and exact UTF-8 bytes.
 * Give up after 64 KiB rather than buffering a large or nonstandard document. */
export function createPreviewHtmlInjector() {
  let prefix = NodeBuffer.Buffer.alloc(0);
  let finished = false;
  return {
    push(chunk: Uint8Array): Uint8Array[] {
      if (finished) return [chunk];
      prefix = NodeBuffer.Buffer.concat([prefix, chunk]);
      const match = /<head(?:\s[^>]*)?>/i.exec(prefix.toString("latin1"));
      if (match && match.index < 65_536) {
        const end = match.index + match[0].length;
        finished = true;
        const output = [
          prefix.subarray(0, end),
          NodeBuffer.Buffer.from(PREVIEW_TELEMETRY_TAG),
          prefix.subarray(end),
        ];
        prefix = NodeBuffer.Buffer.alloc(0);
        return output;
      }
      if (prefix.length >= 65_536) {
        finished = true;
        const output = [prefix];
        prefix = NodeBuffer.Buffer.alloc(0);
        return output;
      }
      return [];
    },
    finish(): Uint8Array[] {
      const output = prefix.length ? [prefix] : [];
      prefix = NodeBuffer.Buffer.alloc(0);
      finished = true;
      return output;
    },
  };
}

// A classic script executes before the app's module graph. It uses the app's
// existing app-data-ready event and Vite's public HMR hooks, not DOM scraping.
export const previewTelemetryScript = String.raw`(() => {
  if (window.__compadreTelemetry) return;
  window.__compadreTelemetry = true;
  const endpoint = "/.compadre/preview/telemetry";
  const pageId = crypto.randomUUID();
  const key = "compadre.preview.observation.v1";
  let previous = {}, tabId = crypto.randomUUID();
  try { previous = JSON.parse(sessionStorage.getItem(key) || "{}"); tabId = previous.tabId || tabId; } catch {}
  let pendingReason = "unknown", pendingReasonAt = 0, lastInteraction = performance.now(), interactionCount = 0, eventCount = 0;
  const stats = { resourceCount: 0, resourceDurationMs: 0, resourceMaxMs: 0, apiCount: 0, apiDurationMs: 0, moduleCount: 0, transferredBytes: 0 };
  const clamp = n => Math.max(0, Math.min(86400000, Math.round(Number(n) || 0)));
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify({ pageId, tabId, reason: pendingReason, reasonAt: pendingReasonAt, at: Date.now() })); } catch {} };
  save();
  const isActivation = () => !!document.querySelector('meta[name="compadre-preview-activation"]');
  function report(kind) {
    try {
      if (kind !== "heartbeat" && ++eventCount > 40) return;
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const recent = Date.now() - previous.at < 86400000;
      const payload = {
        version: 1, pageId, tabId, ...(recent && previous.pageId ? { previousPageId: previous.pageId } : {}),
        kind, pageKind: isActivation() ? "activation" : "application",
        navigationType: nav.type || "unknown", previousReason: Date.now() - previous.reasonAt < 15000 ? previous.reason || "unknown" : "unknown",
        elapsedMs: clamp(performance.now()), visible: document.visibilityState === "visible",
        wasDiscarded: !!document.wasDiscarded, interactionAgeMs: clamp(performance.now() - lastInteraction), interactionCount,
        ...stats, ttfbMs: clamp(nav.responseStart), domReadyMs: clamp(nav.domContentLoadedEventEnd), loadMs: clamp(nav.loadEventEnd)
      };
      navigator.sendBeacon(endpoint, new Blob([JSON.stringify(payload)], { type: "application/json" }));
    } catch {}
  }
  const mark = (kind, reloadReason) => { if (reloadReason) { pendingReason = reloadReason; pendingReasonAt = Date.now(); save(); } report(kind); };
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const url = new URL(entry.name, location.href);
        if (url.origin !== location.origin || url.pathname.startsWith("/.compadre/")) continue;
        stats.resourceCount++;
        stats.resourceDurationMs = clamp(stats.resourceDurationMs + entry.duration);
        stats.resourceMaxMs = clamp(Math.max(stats.resourceMaxMs, entry.duration));
        stats.transferredBytes += entry.transferSize || 0;
        if (url.pathname.startsWith("/api/")) { stats.apiCount++; stats.apiDurationMs = clamp(stats.apiDurationMs + entry.duration); }
        if (/\.[cm]?[jt]sx?$/.test(url.pathname) || url.pathname.startsWith("/@")) stats.moduleCount++;
      }
    }).observe({ type: "resource", buffered: true });
  } catch {}
  for (const name of ["pointerdown", "keydown", "scroll"]) addEventListener(name, event => { if (event.isTrusted) { lastInteraction = performance.now(); interactionCount++; } }, { passive: true });
  addEventListener("app-data-ready", () => report("app_ready"), { once: true });
  addEventListener("compadre-preview-ready", () => mark("activation_ready", "activation_ready"));
  addEventListener("compadre-preview-failed", () => report("activation_failed"));
  addEventListener("vite:preloadError", () => mark("vite_preload_error", "vite_preload_error"));
  addEventListener("pagehide", () => { save(); report("pagehide"); });
  document.addEventListener("visibilitychange", () => report("visibility"));
  addEventListener("load", () => setTimeout(() => report("window_load"), 0), { once: true });
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => report("dom_ready"), 0);
    if (!document.querySelector('script[src*="/@vite/client"]')) return;
    void import("/@vite/client").then(({ createHotContext }) => {
      const hot = createHotContext("/.compadre/preview/telemetry.js");
      hot.on("vite:beforeFullReload", () => mark("vite_full_reload", "vite_full_reload"));
      hot.on("vite:ws:disconnect", () => mark("vite_disconnect", "vite_disconnect"));
      hot.on("vite:ws:connect", () => report("vite_connect"));
    }).catch(() => {});
  }, { once: true });
  setInterval(() => { if (document.visibilityState === "visible") report("heartbeat"); }, 60000);
  report("navigation");
})();`;
