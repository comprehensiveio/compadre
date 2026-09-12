import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const require = NodeModule.createRequire(NodePath.join(root, "hosted/compadre/package.json"));
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const state = process.argv[2];
if (!state) throw new Error("Usage: node scripts/compadre-e2e/check-storage.mjs /state/directory");
const { project, env } = JSON.parse(
  NodeFS.readFileSync(NodePath.join(state, "compose-private.json")),
);
if (!/^compadre-e2e-[a-z0-9]+$/.test(project)) throw new Error("Expected E2E Compose project");
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  NodePath.join(root, "scripts/compadre-e2e/compose.yaml"),
];
function docker(args) {
  const result = NodeChildProcess.spawnSync("docker", [...compose, ...args], {
    env,
    stdio: "ignore",
  });
  if (result.status !== 0) throw new Error("Compose storage operation failed");
}
docker(["up", "-d", "--wait", "s3"]);
const client = new S3Client({
  endpoint: `http://127.0.0.1:${env.E2E_S3_PORT}`,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "e2e", secretAccessKey: env.E2E_S3_PASSWORD },
});
const key = `restart-proof/${NodeCrypto.randomUUID()}`;
const body = NodeCrypto.randomBytes(128);
try {
  await client.send(new PutObjectCommand({ Bucket: "compadre-e2e", Key: key, Body: body }));
  docker(["stop", "s3"]);
  docker(["up", "-d", "--wait", "s3"]);
  const object = await client.send(new GetObjectCommand({ Bucket: "compadre-e2e", Key: key }));
  if (!body.equals(Buffer.from(await object.Body.transformToByteArray())))
    throw new Error("Object changed across restart");
  await client.send(new DeleteObjectCommand({ Bucket: "compadre-e2e", Key: key }));
  console.log("S3 stop/start persistence passed (exact bytes).");
} finally {
  client.destroy();
}
