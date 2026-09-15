import assert from "node:assert/strict";
import test from "node:test";
import { isModalSnapshotUnavailableError } from "./modal-errors.js";

test("recognizes Modal's expired and missing snapshot responses only at provisioning", () => {
  for (const details of [
    "Image 'im-old' has expired",
    "Image 'im-old' not found",
    "Image im-old does not exist",
  ]) {
    assert.equal(
      isModalSnapshotUnavailableError(
        Object.assign(new Error(details), {
          path: "/modal.client.ModalClient/SandboxCreate",
          code: 5,
          details,
        }),
        "im-old",
      ),
      true,
    );
  }
  assert.equal(
    isModalSnapshotUnavailableError(
      new Error(
        "/modal.client.ModalClient/SandboxCreate NOT_FOUND: Image 'im-old' has expired",
      ),
      "im-old",
    ),
    true,
  );
  for (const message of [
    "/modal.client.ModalClient/SandboxCreate RESOURCE_EXHAUSTED: Workspace has exceeded its spend limit",
    "/modal.client.ModalClient/SandboxCreate NOT_FOUND: App not found",
    "/modal.client.ModalClient/SandboxCreate NOT_FOUND: Image 'im-other' has expired",
    "checkout failed: image im-old not found",
    "/modal.client.ModalClient/SandboxExec NOT_FOUND: Image 'im-old' has expired",
  ])
    assert.equal(
      isModalSnapshotUnavailableError(new Error(message), "im-old"),
      false,
    );
});
