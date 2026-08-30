import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { closeHttpServer } from "./http-shutdown.js";

test("stops accepting connections but lets an in-flight request finish", async () => {
  let releaseRequest!: () => void;
  const requestReleased = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let requestStarted!: () => void;
  const requestDidStart = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const server = createServer(async (_request, response) => {
    requestStarted();
    await requestReleased;
    response.end("done");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const response = fetch(`http://127.0.0.1:${address.port}`);
  await requestDidStart;
  let closed = false;
  const closing = closeHttpServer(server).then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  releaseRequest();
  assert.equal(await (await response).text(), "done");
  await closing;
  assert.equal(closed, true);
});

test("surfaces a listener close failure", async () => {
  const failure = new Error("close failed");
  await assert.rejects(
    closeHttpServer({ close: (callback) => callback(failure) }),
    failure,
  );
});
