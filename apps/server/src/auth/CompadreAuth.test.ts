import { describe, expect, it } from "vite-plus/test";

import {
  attributeCompadreWebCommand,
  decodeCompadreUserSubject,
  encodeCompadreUserSubject,
  exchangeCompadreLoginGrant,
  isAllowedCompadreSession,
  isCompadreAuthEnabled,
  normalizeCompadreReturnTo,
} from "./CompadreAuth.ts";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";

describe("CompadreAuth", () => {
  it("requires Slack-backed browser sessions only in hosted Compadre mode", () => {
    const enabled = { VITE_COMPADRE_AUTH_ENABLED: "true" };
    expect(isCompadreAuthEnabled(enabled)).toBe(true);
    expect(
      isAllowedCompadreSession(
        { method: "browser-session-cookie", subject: "pairing-session" },
        enabled,
      ),
    ).toBe(false);
    expect(
      isAllowedCompadreSession(
        {
          method: "browser-session-cookie",
          subject: encodeCompadreUserSubject({ id: "user-1", displayName: "Isaac" }),
        },
        enabled,
      ),
    ).toBe(true);
    expect(
      isAllowedCompadreSession({ method: "bearer-access-token", subject: "relay" }, enabled),
    ).toBe(true);
    expect(
      isAllowedCompadreSession(
        { method: "browser-session-cookie", subject: "pairing-session" },
        {},
      ),
    ).toBe(true);
  });

  it("allows only same-origin relative return paths", () => {
    expect(normalizeCompadreReturnTo("/environment/thread?view=full")).toBe(
      "/environment/thread?view=full",
    );
    expect(normalizeCompadreReturnTo("https://attacker.example/path")).toBe("/");
    expect(normalizeCompadreReturnTo("//attacker.example/path")).toBe("/");
    expect(normalizeCompadreReturnTo("/safe\\..\\unsafe")).toBe("/");
  });

  it("allows only UUID-scoped HTTPS preview return URLs", () => {
    const environment = {
      COMPADRE_PREVIEW_HOST_SUFFIX: "dev.compadre.comprehensive.io",
    };
    const valid =
      "https://e160a306-b842-57ba-a8f2-04de157e5366.dev.compadre.comprehensive.io/employees";
    expect(normalizeCompadreReturnTo(valid, environment)).toBe(valid);
    expect(normalizeCompadreReturnTo("https://attacker.example/employees", environment)).toBe("/");
    expect(
      normalizeCompadreReturnTo(
        "https://not-a-thread.dev.compadre.comprehensive.io/employees",
        environment,
      ),
    ).toBe("/");
  });

  it("exchanges a one-time grant without exposing it in a URL", async () => {
    let request: Request | undefined;
    const result = await exchangeCompadreLoginGrant({
      controllerUrl: new URL("https://controller.example"),
      serviceToken: "service-token",
      code: "one-time-code",
      fetch: async (input, init) => {
        request = new Request(input.toString(), init);
        return new Response(
          JSON.stringify({
            ok: true,
            user: { id: "user-1", displayName: "Isaac" },
            returnTo: "/environment/thread",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(request?.url).toBe("https://controller.example/internal/auth/exchange");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer service-token");
    expect(await request?.json()).toEqual({ code: "one-time-code" });
    expect(result).toEqual({
      ok: true,
      user: { id: "user-1", displayName: "Isaac" },
      returnTo: "/environment/thread",
    });
  });

  it("derives trusted web-message attribution from the authenticated session", () => {
    const subject = encodeCompadreUserSubject({
      id: "user-1",
      displayName: "Isaac",
      avatarUrl: "https://example.com/isaac.png",
    });
    expect(decodeCompadreUserSubject(subject)).toEqual({
      id: "user-1",
      displayName: "Isaac",
      avatarUrl: "https://example.com/isaac.png",
    });

    const command = attributeCompadreWebCommand(
      {
        type: "thread.turn.start",
        commandId: CommandId.make("command-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Hello",
          attachments: [],
          attribution: {
            userId: "forged-user",
            displayName: "Forged",
            origin: "api",
          },
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-27T15:00:00.000Z",
      },
      subject,
    );

    expect(command.type).toBe("thread.turn.start");
    if (command.type !== "thread.turn.start") throw new Error("Expected a turn command");
    expect(command.message.attribution).toEqual({
      userId: "user-1",
      displayName: "Isaac",
      avatarUrl: "https://example.com/isaac.png",
      origin: "web",
    });
  });
});
