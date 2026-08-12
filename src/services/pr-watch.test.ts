import assert from "node:assert/strict";
import test from "node:test";
import { selectProductionCmServiceId, type RenderService } from "./pr-watch.js";

const primaryService: RenderService = {
  id: "srv-primary",
  name: "cm-app-ktj4",
  type: "web_service",
  repo: "https://github.com/comprehensiveio/comp",
  branch: "prod",
  suspended: "not_suspended",
};

test("selects only the primary CM production app service", () => {
  assert.equal(
    selectProductionCmServiceId([
      primaryService,
      { ...primaryService, id: "srv-other-app", name: "customer-app" },
      { ...primaryService, id: "srv-staging", branch: "main" },
      { ...primaryService, id: "srv-worker", name: "cm-worker-prod" },
    ]),
    "srv-primary",
  );
});

test("fails closed when the primary production service is ambiguous", () => {
  assert.throws(
    () =>
      selectProductionCmServiceId([
        primaryService,
        { ...primaryService, id: "srv-second", name: "cm-app-second" },
      ]),
    /Expected one active cm-app-/,
  );
});
