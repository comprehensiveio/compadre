import { describe, expect, it } from "vite-plus/test";

import {
  attributeCompadreWebCommand,
  decodeCompadreUserSubject,
  encodeCompadreUserSubject,
  exchangeCompadreLoginGrant,
  normalizeCompadreReturnTo,
} from "./CompadreAuth.ts";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";

describe("CompadreAuth", () => {
  it("allows only same-origin relative return paths", () => {
    expect(normalizeCompadreReturnTo("/environment/thread?view=full")).toBe(
      "/environment/thread?view=full",
    );
    expect(normalizeCompadreReturnTo("https://attacker.example/path")).toBe("/");
    expect(normalizeCompadreReturnTo("//attacker.example/path")).toBe("/");
    expect(normalizeCompadreReturnTo("/safe\\..\\unsafe")).toBe("/");
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
