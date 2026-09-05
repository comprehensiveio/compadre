// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import {
  makeAttachmentStore,
  makeS3AttachmentObjects,
} from "../src/assets/CompadreAttachmentObjects.ts";
import { makePostgresPersistenceLive } from "../src/persistence/Layers/Postgres.ts";
const source = process.argv[2];
const url = process.env.COMPADRE_T3_POSTGRES_URL;
if (!source || !url)
  throw new Error(
    "Usage: node dist/import-central-attachments.mjs <snapshot attachment directory>; configure COMPADRE_T3_POSTGRES_URL and COMPADRE_T3_ATTACHMENT_BUCKET/REGION.",
  );
const root = NodePath.resolve(source);
Effect.gen(function* () {
  const store = yield* makeAttachmentStore(yield* makeS3AttachmentObjects, root);
  let count = 0;
  for (const name of NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const file = NodePath.join(root, name);
    const info = NodeFS.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error("Attachment imports must not contain symlinks.");
    if (!info.isFile() || name.endsWith(".part")) continue;
    yield* store.persist(file);
    count++;
  }
  yield* Effect.logInfo("Imported and read-back verified attachment files", { count });
}).pipe(
  Effect.provide([makePostgresPersistenceLive(url), NodeServices.layer]),
  Effect.scoped,
  NodeRuntime.runMain,
);
