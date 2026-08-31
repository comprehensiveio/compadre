import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeT3GatewayEnabled,
  stopConfiguredT3WorkerLifecycle,
} from "./runtime.js";

test("starts the native T3 gateway eagerly for every hosted entrypoint", () => {
  for (const name of [
    "COMPADRE_T3_DIRECTORY_ENABLED",
    "COMPADRE_T3_SLACK_ENABLED",
    "COMPADRE_T3_API_ENABLED",
    "COMPADRE_HOSTED_T3_ENABLED",
  ]) {
    assert.equal(nativeT3GatewayEnabled({ [name]: "true" }), true, name);
  }
});

test("does not start the Modal lifecycle for disabled legacy services", () => {
  assert.equal(nativeT3GatewayEnabled({}), false);
  assert.equal(
    nativeT3GatewayEnabled({ COMPADRE_T3_DIRECTORY_ENABLED: "false" }),
    false,
  );
});

test("stopping an uninitialized worker lifecycle is idempotent", () => {
  assert.doesNotThrow(() => {
    stopConfiguredT3WorkerLifecycle();
    stopConfiguredT3WorkerLifecycle();
  });
});
