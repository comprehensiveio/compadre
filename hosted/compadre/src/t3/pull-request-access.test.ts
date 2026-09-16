import assert from "node:assert/strict";
import test from "node:test";
import { forwardPullRequestRequest, pullRequestAccessProjection } from "./pull-request-access.js";

test("projects an expiring canonical-thread credential and reissues it on restore", () => {
  assert.deepEqual(pullRequestAccessProjection({}), {});
  const environment = {
    COMPADRE_API_KEY: "controller-secret",
    COMPADRE_PUBLIC_URL: "https://controller.example/base",
    COMPADRE_CANONICAL_THREAD_ID: "canonical-thread",
    COMPADRE_MODAL_TIMEOUT_MS: "7200000",
  };
  const projected = pullRequestAccessProjection(environment, () => 100_000);
  assert.equal(projected.COMPADRE_PULL_REQUESTS_URL, "https://controller.example/internal/t3-pull-requests");
  const token = projected.COMPADRE_PULL_REQUESTS_TOKEN!;
  assert.deepEqual(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()), {
    threadId: "canonical-thread", expiresAt: 7600,
  });
  assert.equal(JSON.stringify(projected).includes("controller-secret"), false);
  assert.notEqual(pullRequestAccessProjection(environment, () => 200_000).COMPADRE_PULL_REQUESTS_TOKEN, token);
  assert.throws(() => pullRequestAccessProjection({ COMPADRE_CANONICAL_THREAD_ID: "canonical-thread" }), /requires/);
});

test("relays only the PR operation to central, preserving the scoped token and failure status", async () => {
  const body = { operation: "link", input: { url: "https://github.com/example/repo/pull/42" } };
  const response = await forwardPullRequestRequest({
    authorization: "Bearer scoped-token", body,
    environment: { COMPADRE_T3_CENTRAL_URL: "http://central.internal:10000" },
    fetch: async (url, init) => {
      assert.equal(url.toString(), "http://central.internal:10000/api/compadre/pull-requests");
      assert.deepEqual(init.headers, { authorization: "Bearer scoped-token", "content-type": "application/json" });
      assert.deepEqual(JSON.parse(String(init.body)), body);
      assert.equal(init.redirect, "error");
      return new Response(null, { status: 401, headers: { "x-compadre-pull-requests-version": "1" } });
    },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("fails explicitly for an old central server, absent configuration, and transport failure", async () => {
  const input = {
    authorization: "Bearer scoped-token", body: { operation: "list" },
    environment: { COMPADRE_T3_CENTRAL_URL: "http://central.internal:10000" },
  };
  assert.equal((await forwardPullRequestRequest({ ...input, fetch: async () => new Response("<html>old SPA</html>") })).status, 503);
  assert.equal((await forwardPullRequestRequest({ ...input, environment: {} })).status, 503);
  assert.equal((await forwardPullRequestRequest({ ...input, fetch: async () => { throw new Error("private diagnostic"); } })).status, 502);
});
