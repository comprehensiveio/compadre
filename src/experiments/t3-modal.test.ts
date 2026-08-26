import assert from "node:assert/strict";
import test from "node:test";
import {
  parseT3StartupToken,
  projectedProviderEnvironment,
} from "./t3-modal.js";

test("extracts T3's one-time startup token without accepting lookalikes", () => {
  assert.equal(
    parseT3StartupToken(
      "Listening at http://0.0.0.0:3773\nToken: 23456789ABCD\nPairing URL: http://localhost/pair\n",
    ),
    "23456789ABCD",
  );
  assert.equal(parseT3StartupToken("Token: ABCDEFGHIJKL"), undefined);
  assert.equal(parseT3StartupToken("Token: 23456789ABCDextra"), undefined);
});

test("projects one Compadre MCP bridge into T3's native provider environment", () => {
  assert.deepEqual(
    projectedProviderEnvironment({
      COMPADRE_PUBLIC_URL: "https://compadre-experiment.example/base",
      COMPADRE_T3_MCP_BEARER_TOKEN: "bridge-token",
    }),
    {
      COMPADRE_MCP_URL: "https://compadre-experiment.example/internal/t3-mcp",
      COMPADRE_MCP_BEARER_TOKEN: "bridge-token",
    },
  );
  assert.throws(
    () =>
      projectedProviderEnvironment({
        COMPADRE_T3_MCP_BEARER_TOKEN: "bridge-token",
      }),
    /must be configured together/,
  );
  assert.deepEqual(
    projectedProviderEnvironment({
      COMPADRE_PUBLIC_URL: "https://compadre-experiment.example",
      COMPADRE_API_KEY: "experiment-api-key",
    }),
    {
      COMPADRE_MCP_URL: "https://compadre-experiment.example/internal/t3-mcp",
      COMPADRE_MCP_BEARER_TOKEN: "experiment-api-key",
    },
  );
});
