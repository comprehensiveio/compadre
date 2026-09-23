import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import * as SessionStore from "./SessionStore.ts";
import { encodeCompadreUserSubject } from "./CompadreAuth.ts";
import { compadrePreviewGatewayLayer } from "./CompadrePreviewGateway.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  previewGatewayConfiguration,
  previewThreadIdFromHost,
  rewritePreviewRequestHeaders,
  rewritePreviewResponse,
  withoutCookie,
} from "./CompadrePreviewGateway.ts";
import { previewActivationHtml } from "./CompadrePreviewActivationPage.ts";

const threadId = "e160a306-b842-57ba-a8f2-04de157e5366";
const suffix = "dev.compadre.comprehensive.io";

describe("CompadrePreviewGateway", () => {
  it("recognizes only UUID thread subdomains when fully configured", () => {
    expect(
      previewGatewayConfiguration({
        COMPADRE_CONTROLLER_URL: "https://controller.example",
        COMPADRE_PREVIEW_GATEWAY_SECRET: "secret",
        COMPADRE_PREVIEW_HOST_SUFFIX: suffix,
      }),
    ).toMatchObject({ serviceToken: "secret", hostSuffix: suffix });
    expect(previewThreadIdFromHost(`${threadId}.${suffix}`, suffix)).toBe(threadId);
    expect(previewThreadIdFromHost(`${threadId}.${suffix}:443`, suffix)).toBe(threadId);
    expect(previewThreadIdFromHost(`not-a-thread.${suffix}`, suffix)).toBeNull();
    expect(previewThreadIdFromHost(`${threadId}.attacker.example`, suffix)).toBeNull();
  });

  it("strips only the T3 gateway session before forwarding to Comp", () => {
    expect(
      withoutCookie("t3_session=secret; connect.sid=comp-user; theme=grove", "t3_session"),
    ).toBe("connect.sid=comp-user; theme=grove");
    expect(withoutCookie("connect.sid=comp-user", "t3_session")).toBe("connect.sid=comp-user");
  });

  it("rewrites browser security headers to the private Modal origin", () => {
    const preview = `https://${threadId}.${suffix}`;
    const target = "https://sandbox-3000.modal.host";
    const headers = rewritePreviewRequestHeaders(
      {
        host: `${threadId}.${suffix}`,
        origin: preview,
        referer: `${preview}/company/employees?tab=active`,
        cookie: "t3_session=secret; connect.sid=comp-user",
      },
      "t3_session",
      preview,
      target,
    );
    expect(headers.get("host")).toBeNull();
    expect(headers.get("origin")).toBe(target);
    expect(headers.get("referer")).toBe(`${target}/company/employees?tab=active`);
    expect(headers.get("cookie")).toBe("connect.sid=comp-user");
    expect(headers.get("x-forwarded-host")).toBe(`${threadId}.${suffix}`);
  });

  it("keeps Comp redirects and cookies on the authenticated preview host", () => {
    const target = "https://sandbox-3000.modal.host";
    const preview = `https://${threadId}.${suffix}`;
    const response = rewritePreviewResponse(
      new Response(null, {
        status: 302,
        headers: {
          location: `${target}/api/v1/auth/dev/login/user-1?next=%2Femployees`,
          "set-cookie": "connect.sid=value; Domain=sandbox-3000.modal.host; Path=/; HttpOnly",
        },
      }),
      target,
      preview,
    );
    expect(response.headers.get("location")).toBe(
      `${preview}/api/v1/auth/dev/login/user-1?next=%2Femployees`,
    );
    expect(response.headers.get("set-cookie")).toContain("connect.sid=value");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
  });

  it("renders a self-starting interstitial without reflecting unsafe error markup", () => {
    const starting = previewActivationHtml("idle");
    expect(starting).toContain("Waking up your environment");
    expect(starting).toContain("/.compadre/preview/activate");
    expect(starting).toContain("/.compadre/preview/status");

    const failed = previewActivationHtml("failed", '<script>alert("x")</script>');
    expect(failed).toContain("Preview could not start");
    expect(failed).toContain("&lt;script&gt;");
    expect(failed).not.toContain('<script>alert("x")</script>');
  });
});

// Exercise the middleware boundary: telemetry must not contact the controller
// or Modal, even when the referenced environment is asleep.
describe("preview telemetry routes", () => {
  it("keeps authenticated telemetry central and rejects cross-origin or oversized reports", async () => {
    const origin = `https://${threadId}.${suffix}`;
    const previous = { ...process.env };
    process.env.COMPADRE_CONTROLLER_URL = "https://controller.example";
    process.env.COMPADRE_PREVIEW_GATEWAY_SECRET = "secret";
    process.env.COMPADRE_PREVIEW_HOST_SUFFIX = suffix;
    let upstreamRequests = 0;
    let servePreview = false;
    const html = "<!doctype html><head><title>Preview</title></head><body>🌱</body>";
    const client = HttpClient.make((request) => {
      upstreamRequests++;
      if (!servePreview) return Effect.die("Telemetry must not resolve a worker");
      if (request.url.startsWith("https://controller.example/")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              ok: true,
              targetUrl: "https://sandbox-3000.modal.host",
            }),
          ),
        );
      }
      expect(request.headers["if-none-match"]).toBeUndefined();
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(html, {
            headers: {
              "content-type": "text/html",
              "content-length": String(new TextEncoder().encode(html).length),
              etag: "old",
              "content-encoding": "gzip",
            },
          }),
        ),
      );
    });
    const { handler, dispose } = HttpRouter.toWebHandler(
      compadrePreviewGatewayLayer.pipe(
        Layer.provide(
          Layer.succeed(SessionStore.SessionStore, {
            cookieName: "session",
            verify: () =>
              Effect.succeed({
                method: "browser-session-cookie",
                subject: encodeCompadreUserSubject({ id: "user-1", displayName: "Test" }),
              }),
          } as unknown as SessionStore.SessionStore["Service"]),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
      { disableLogger: true },
    );
    const post = (body: string, requestOrigin = origin, cookie = "session=test") =>
      handler(
        new Request(`${origin}/.compadre/preview/telemetry`, {
          method: "POST",
          headers: {
            host: `${threadId}.${suffix}`,
            cookie,
            "x-forwarded-proto": "https",
            origin: requestOrigin,
            "content-type": "application/json",
          },
          body,
        }),
      );
    try {
      const script = await handler(
        new Request(`${origin}/.compadre/preview/telemetry.js`, {
          headers: { host: `${threadId}.${suffix}`, cookie: "session=test" },
        }),
      );
      expect(script.status).toBe(200);
      expect(await script.text()).toContain("app-data-ready");
      expect((await post("{}", "https://other.example")).status).toBe(403);
      expect((await post("{}", origin, "")).status).toBe(401);
      expect((await post("{}")).status).toBe(400);
      expect((await post(JSON.stringify({ huge: "x".repeat(9000) }))).status).toBe(400);
      const report = {
        version: 1,
        pageId: "page",
        tabId: "tab",
        kind: "heartbeat",
        pageKind: "application",
        navigationType: "reload",
        previousReason: "unknown",
        elapsedMs: 10,
        visible: true,
        wasDiscarded: false,
        interactionAgeMs: 10,
        interactionCount: 0,
        resourceCount: 0,
        resourceDurationMs: 0,
        resourceMaxMs: 0,
        apiCount: 0,
        apiDurationMs: 0,
        moduleCount: 0,
        transferredBytes: 0,
        ttfbMs: 0,
        domReadyMs: 0,
        loadMs: 0,
      };
      expect((await post(JSON.stringify(report))).status).toBe(204);
      expect(upstreamRequests).toBe(0);
      servePreview = true;
      const page = await handler(
        new Request(origin, {
          headers: {
            host: `${threadId}.${suffix}`,
            cookie: "session=test",
            "x-forwarded-proto": "https",
            "sec-fetch-dest": "document",
            "if-none-match": "old",
          },
        }),
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("content-length")).toBeNull();
      expect(page.headers.get("content-encoding")).toBeNull();
      expect(page.headers.get("etag")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toBe(
        html.replace(
          "<head>",
          '<head><script src="/.compadre/preview/telemetry.js" data-compadre-telemetry></script>',
        ),
      );
      expect(upstreamRequests).toBe(2);
    } finally {
      await dispose();
      for (const key of [
        "COMPADRE_CONTROLLER_URL",
        "COMPADRE_PREVIEW_GATEWAY_SECRET",
        "COMPADRE_PREVIEW_HOST_SUFFIX",
      ]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
