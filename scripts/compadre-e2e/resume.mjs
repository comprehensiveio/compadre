// Retain the databases and worker identities while restarting local applications.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import { assertLocalStack } from "./config.mjs";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const dir = process.argv[2];
if (!dir) throw new Error("Usage: node scripts/compadre-e2e/resume.mjs /state/directory");
const config = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "private.json")));
assertLocalStack(config);
const require = NodeModule.createRequire(NodePath.join(root, "hosted/compadre/package.json"));
const { allow } = require("./../../scripts/compadre-e2e/dns.cjs");
const { S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3");
const children = [];
const base = { PATH: process.env.PATH, HOME: process.env.HOME };
function start(label, command, args, env, cwd = root) {
  const log = NodePath.join(dir, `resume-${label}.log`);
  const fd = NodeFS.openSync(log, "w", 0o600);
  const child = NodeChildProcess.spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  NodeFS.closeSync(fd);
  children.push(child);
  return log;
}
async function ready(label, check) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} not ready; inspect resume logs in ${dir}`);
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children.toReversed())
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {}
    }
  NodeChildProcess.spawnSync("docker", [...config.composeArgs, "stop"], {
    env: config.composeEnv,
    stdio: "ignore",
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const compose = NodeChildProcess.spawnSync(
    "docker",
    [...config.composeArgs, "up", "-d", "--wait"],
    { env: config.composeEnv, stdio: "ignore" },
  );
  if (compose.status !== 0) throw new Error("Compose resume failed");
  async function tunnel(label, target) {
    const log = start(
      label,
      "cloudflared",
      ["tunnel", "--config", "/dev/null", "--url", target, "--no-autoupdate"],
      base,
    );
    let url;
    await ready(
      label,
      () =>
        (url = NodeFS.readFileSync(log, "utf8").match(
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
        )?.[0]),
    );
    allow(new URL(url).hostname);
    return url;
  }
  const objectUrl = await tunnel("objects", `http://127.0.0.1:${config.composeEnv.E2E_S3_PORT}`);
  const callbackUrl = await tunnel("callbacks", `http://127.0.0.1:${config.controller.PORT}`);
  for (const env of [config.central, config.controller]) {
    env.AWS_ENDPOINT_URL_S3 = objectUrl;
    env.COMPADRE_E2E_DNS_HOSTS = [new URL(objectUrl).hostname, new URL(callbackUrl).hostname].join(
      ",",
    );
  }
  config.controller.COMPADRE_PUBLIC_URL = callbackUrl;
  const s3 = new S3Client({
    endpoint: objectUrl,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.central.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.central.AWS_SECRET_ACCESS_KEY,
    },
  });
  try {
    await ready("public S3", () =>
      s3
        .send(new HeadBucketCommand({ Bucket: "compadre-e2e" }), {
          abortSignal: AbortSignal.timeout(5000),
        })
        .then(
          () => true,
          () => false,
        ),
    );
  } finally {
    s3.destroy();
  }
  const port = new URL(config.controller.COMPADRE_T3_CENTRAL_URL).port;
  const log = start(
    "central",
    "vp",
    ["run", "dev", "--home-dir", config.central.T3CODE_HOME, "--port", port],
    config.central,
  );
  let webPort;
  await ready(
    "dev runner",
    () => (webPort = NodeFS.readFileSync(log, "utf8").match(/webPort=(\d+)/)?.[1]),
  );
  config.webUrl = `http://localhost:${webPort}`;
  config.controller.COMPADRE_T3_HOSTED_APP_URL = config.webUrl;
  NodeFS.writeFileSync(NodePath.join(dir, "private.json"), JSON.stringify(config), { mode: 0o600 });
  const manifestPath = NodePath.join(dir, "manifest.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath));
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, webUrl: config.webUrl }, null, 2),
  );
  start(
    "controller",
    "node",
    ["--import", "tsx", "src/start.ts"],
    config.controller,
    NodePath.join(root, "hosted/compadre"),
  );
  for (const url of [
    config.controller.COMPADRE_T3_CENTRAL_URL + "/api/auth/session",
    `http://127.0.0.1:${config.controller.PORT}/health`,
    config.webUrl,
  ]) {
    await ready("application", () =>
      fetch(url, { signal: AbortSignal.timeout(5000) }).then(
        (r) => r.ok,
        () => false,
      ),
    );
  }
  console.log(
    `Resumed: ${config.webUrl}\nLogin: node scripts/compadre-e2e.mjs login --state ${dir}`,
  );
} catch (error) {
  console.error(error.message);
  stop();
  process.exitCode = 1;
}
