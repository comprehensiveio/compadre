import assert from "node:assert/strict";
import test from "node:test";
import { parseT3StartupToken } from "./t3-modal.js";

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
