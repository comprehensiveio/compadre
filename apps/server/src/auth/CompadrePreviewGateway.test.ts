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
