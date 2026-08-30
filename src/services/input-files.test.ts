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

test("materializes a generic authenticated file without changing its extension", () => {
  const file = inputFileSchema.parse({
    name: "notes.txt",
    mimetype: "text/plain",
    sizeBytes: 5,
    dataBase64: "bm90ZXM=",
  });
  const materialized = materializeInputFiles([file], "/workspace/.attachments");
  assert.equal(materialized.uploads[0]?.path, "/workspace/.attachments/1-web-notes.txt");
  assert.equal(new TextDecoder().decode(materialized.uploads[0]!.data), "notes");
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

test("rejects malformed base64 even when it decodes to the declared size", () => {
  assert.equal(
    inputFileSchema.safeParse({
      name: "probe.png",
      mimetype: "image/png",
      sizeBytes: 0,
      dataBase64: "a",
    }).success,
    false,
  );
});
