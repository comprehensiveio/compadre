import assert from "node:assert/strict";
import test from "node:test";
import { workflowErrorDetails } from "./diagnostics.js";

test("Workflow error details retain stack and cause", () => {
  const error = new Error("agent failed", { cause: "SIGKILL" });
  const details = workflowErrorDetails(error);
  assert.equal(details.errorName, "Error");
  assert.equal(details.errorMessage, "agent failed");
  assert.equal(details.errorCause, "SIGKILL");
  assert.match(details.errorStack ?? "", /agent failed/);
});
