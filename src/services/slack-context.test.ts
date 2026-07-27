import assert from "node:assert/strict";
import test from "node:test";
import { fetchSlackChannelName } from "./slack-context.js";

test("resolves a public Slack channel name", async () => {
  const requests: string[] = [];
  const fetchImplementation: typeof fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      ok: true,
      channel: { name: "production-support" },
    });
  };

  const name = await fetchSlackChannelName(
    {
      channel: "C123",
      botToken: "test-token",
    },
    fetchImplementation,
  );

  assert.equal(name, "#production-support");
  assert.match(requests[0], /conversations\.info\?channel=C123$/);
});

test("describes a direct message using the sender's display name", async () => {
  const fetchImplementation: typeof fetch = async () =>
    Response.json({
      ok: true,
      user: {
        profile: {
          display_name: "Isaac",
          real_name: "Isaac Sherrill",
        },
      },
    });

  const name = await fetchSlackChannelName(
    {
      channel: "D123",
      userId: "U123",
      botToken: "test-token",
    },
    fetchImplementation,
  );

  assert.equal(name, "Direct message with Isaac");
});

test("returns null when Slack cannot resolve the conversation", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const fetchImplementation: typeof fetch = async () =>
      Response.json({ ok: false, error: "channel_not_found" });

    const name = await fetchSlackChannelName(
      {
        channel: "C404",
        botToken: "test-token",
      },
      fetchImplementation,
    );

    assert.equal(name, null);
  } finally {
    console.error = originalConsoleError;
  }
});
