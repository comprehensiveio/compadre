import assert from "node:assert/strict";
import test from "node:test";
import {
  inputFileSchema,
  materializeInputFiles,
} from "./input-files.js";

test("materializes an authenticated browser image for Modal", () => {
  const file = inputFileSchema.parse({
    name: "screen shot.png",
    mimetype: "image/png",
    sizeBytes: 4,
    dataBase64: "iVBORw==",
  });
  const materialized = materializeInputFiles([file], "/workspace/.attachments");
  assert.equal(materialized.uploads[0]?.path, "/workspace/.attachments/1-web-screen_shot.png");
  assert.deepEqual([...materialized.uploads[0]!.data], [137, 80, 78, 71]);
  assert.match(materialized.prompt, /1-web-screen_shot\.png/);
});

test("rejects browser attachment sizes that do not match their bytes", () => {
  const parsed = inputFileSchema.safeParse({
    name: "probe.png",
    mimetype: "image/png",
    sizeBytes: 3,
    dataBase64: "iVBORw==",
  });
  assert.equal(parsed.success, false);
});
