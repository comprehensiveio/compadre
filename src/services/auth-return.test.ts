import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuthReturnTo } from "./auth-store.js";

test("allows only UUID-scoped HTTPS preview return URLs", () => {
  const suffix = "dev.compadre.comprehensive.io";
  const valid =
    "https://e160a306-b842-57ba-a8f2-04de157e5366.dev.compadre.comprehensive.io/employees";
  assert.equal(normalizeAuthReturnTo(valid, suffix), valid);
  assert.equal(
    normalizeAuthReturnTo("https://attacker.example/employees", suffix),
    "/",
  );
  assert.equal(
    normalizeAuthReturnTo(
      "https://not-a-thread.dev.compadre.comprehensive.io/employees",
      suffix,
    ),
    "/",
  );
  assert.equal(
    normalizeAuthReturnTo(
      "http://e160a306-b842-57ba-a8f2-04de157e5366.dev.compadre.comprehensive.io/employees",
      suffix,
    ),
    "/",
  );
});
