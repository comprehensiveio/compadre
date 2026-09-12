import { developmentCredentials, assertLocalStack, issuedToken } from "./compadre-e2e/config.mjs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const controller = NodePath.join(root, "hosted/compadre");
const requireController = NodeModule.createRequire(NodePath.join(controller, "package.json"));
const { parse } = requireController("dotenv");
const dnsPreload = NodePath.join(root, "scripts/compadre-e2e/dns.cjs");
const { allow: allowTunnelDns } = requireController(dnsPreload);
const args = process.argv.slice(2);
const command = args.shift();
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const base = {
  PATH: process.env.PATH,
  HOME: NodeOS.homedir(),
  TMPDIR: NodeOS.tmpdir(),
  LANG: "en_US.UTF-8",
};
const children = [];
let composeStarted = false;
let composeEnv;
let composeArgs;
let stopping = false;
const state = option("--state");
if (command === "cleanup") {
  if (!state) throw new Error("cleanup requires --state");
  const config = JSON.parse(
    await NodeFSP.readFile(NodePath.join(state, "compose-private.json"), "utf8"),
  );
  if (!/^compadre-e2e-[a-z0-9]+$/.test(config.project))
    throw new Error("Expected an E2E Compose project");
  const result = NodeChildProcess.spawnSync(
    "docker",
    [
      "compose",
      "-p",
      config.project,
      "-f",
      NodePath.join(root, "scripts/compadre-e2e/compose.yaml"),
      "down",
      "--volumes",
    ],
    {
      env: { ...base, ...config.env },
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
if (command === "login") {
  if (!state) throw new Error("login requires --state");
  const config = JSON.parse(await NodeFSP.readFile(NodePath.join(state, "private.json"), "utf8"));
  assertLocalStack(config);
  const result = NodeChildProcess.spawnSync(
    "node",
    ["--import", "tsx", "scripts/local-e2e-login.ts", option("--user") ?? "alice"],
    {
      cwd: controller,
      env: { ...base, ...config.controller, COMPADRE_E2E_WEB_URL: config.webUrl },
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
if (command !== "up" || !option("--credentials")) {
  console.log(
    "node scripts/compadre-e2e.mjs up --credentials /path/to/.env.local\nnode scripts/compadre-e2e.mjs login --state /printed/state/path [--user alice|bob]",
  );
  process.exit(command ? 1 : 0);
}
if (await NodeFSP.stat(NodePath.join(controller, ".env.local")).catch(() => null)) {
  throw new Error(
    "Use an isolated worktree without controller .env.local; credentials are selected explicitly.",
  );
}
const selected = parse(await NodeFSP.readFile(option("--credentials")));
const credentials = developmentCredentials(selected, process.env);
const { ModalClient } = requireController("modal");
const modal = new ModalClient({
  tokenId: credentials.MODAL_TOKEN_ID,
  tokenSecret: credentials.MODAL_TOKEN_SECRET,
});
try {
  const identity = await modal.cpClient.tokenInfoGet({});
  if (identity.workspaceName !== "comprehensiveio")
    throw new Error("E2E Modal credentials must belong to Comprehensive");
  console.log(`Modal workspace: ${identity.workspaceName}`);
} finally {
  modal.close();
}
const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "compadre-e2e-"));
await NodeFSP.chmod(dir, 0o700);
const session = NodePath.basename(dir).toLowerCase();
const port = () =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
const [pgPort, temporalPort, apiPort, serverPort, s3Port] = await Promise.all([
  port(),
  port(),
  port(),
  port(),
  port(),
]);
const secret = () => NodeCrypto.randomBytes(32).toString("hex");
const apiKey = secret();
const exchange = secret();
const dbUrl = `postgres://e2e:${secret()}@127.0.0.1:${pgPort}/compadre_e2e_test`;
const pgPassword = new URL(dbUrl).password;
function start(label, executable, argv, env = base, cwd = root) {
  const log = NodePath.join(dir, `${label}.log`);
  const fd = NodeFS.openSync(log, "a", 0o600);
  const child = NodeChildProcess.spawn(executable, argv, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  NodeFS.closeSync(fd);
  children.push(child);
  child.once("error", (error) => console.error(`${label}: ${error.message}`));
  return { child, log };
}
async function run(label, executable, argv, env = base, cwd = root) {
  const { child, log } = start(label, executable, argv, env, cwd);
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  if (code !== 0) throw new Error(`${label} failed (${code}); inspect ${log}`);
}
async function waitFor(label, check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} was not ready; logs: ${dir}`);
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children.toReversed())
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {}
    }
  if (composeStarted)
    NodeChildProcess.spawnSync("docker", [...composeArgs, "stop"], {
      env: composeEnv,
      stdio: "ignore",
    });
  console.log(
    `Local services stopped; state and logs retained in ${dir}. Modal workers have a one-hour lifetime.`,
  );
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  console.log(`E2E state: ${dir}`);
  composeEnv = {
    ...base,
    E2E_POSTGRES_PASSWORD: pgPassword,
    E2E_POSTGRES_PORT: String(pgPort),
    E2E_TEMPORAL_PORT: String(temporalPort),
    E2E_S3_PORT: String(s3Port),
  };
  composeArgs = [
    "compose",
    "-p",
    session,
    "-f",
    NodePath.join(root, "scripts/compadre-e2e/compose.yaml"),
  ];
  await NodeFSP.writeFile(
    NodePath.join(dir, "compose-private.json"),
    JSON.stringify({ project: session, env: composeEnv }),
    { mode: 0o600 },
  );
  composeStarted = true;
  await run("compose", "docker", [...composeArgs, "up", "-d", "--wait"], composeEnv);
  await waitFor(
    "Temporal",
    async () =>
      NodeChildProcess.spawnSync(
        "temporal",
        ["operator", "cluster", "health", "--address", `127.0.0.1:${temporalPort}`],
        { env: base, stdio: "ignore" },
      ).status === 0,
  );
  const awsEnv = {
    AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${s3Port}`,
    AWS_ACCESS_KEY_ID: "e2e",
    AWS_SECRET_ACCESS_KEY: secret(),
    AWS_REGION: "us-east-1",
  };
  const { S3Client, CreateBucketCommand, HeadBucketCommand } =
    requireController("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: awsEnv.AWS_REGION,
    endpoint: awsEnv.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: {
      accessKeyId: awsEnv.AWS_ACCESS_KEY_ID,
      secretAccessKey: awsEnv.AWS_SECRET_ACCESS_KEY,
    },
  });
  await waitFor("S3", async () => {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: "compadre-e2e" }));
      return true;
    } catch {
      return false;
    }
  });
  s3.destroy();
  const objectTunnel = start("object-tunnel", "cloudflared", [
    "tunnel",
    "--config",
    "/dev/null",
    "--url",
    `http://127.0.0.1:${s3Port}`,
    "--http-host-header",
    "localhost",
    "--no-autoupdate",
  ]);
  awsEnv.AWS_ENDPOINT_URL_S3 = await waitFor(
    "object tunnel",
    async () =>
      (await NodeFSP.readFile(objectTunnel.log, "utf8")).match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      )?.[0],
  );
  allowTunnelDns(new URL(awsEnv.AWS_ENDPOINT_URL_S3).hostname);
  const publicS3 = new S3Client({
    region: awsEnv.AWS_REGION,
    endpoint: awsEnv.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: {
      accessKeyId: awsEnv.AWS_ACCESS_KEY_ID,
      secretAccessKey: awsEnv.AWS_SECRET_ACCESS_KEY,
    },
  });
  await waitFor("public S3", async () => {
    try {
      await publicS3.send(new HeadBucketCommand({ Bucket: "compadre-e2e" }));
      return true;
    } catch {
      return false;
    }
  });
  publicS3.destroy();
  const tunnel = start("tunnel", "cloudflared", [
    "tunnel",
    "--config",
    "/dev/null",
    "--url",
    `http://127.0.0.1:${apiPort}`,
    "--no-autoupdate",
  ]);
  const publicUrl = await waitFor(
    "controller tunnel",
    async () =>
      (await NodeFSP.readFile(tunnel.log, "utf8")).match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      )?.[0],
  );
  allowTunnelDns(new URL(publicUrl).hostname);
  const tunnelDnsEnv = {
    COMPADRE_E2E_DNS_HOSTS: [
      new URL(publicUrl).hostname,
      new URL(awsEnv.AWS_ENDPOINT_URL_S3).hostname,
    ].join(","),
    NODE_OPTIONS: `--require ${JSON.stringify(dnsPreload)}`,
  };
  await run(
    "server-build",
    "vp",
    ["run", "build:bundle"],
    base,
    NodePath.join(root, "apps/server"),
  );
  await run(
    "worker-package",
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", dir],
    base,
    NodePath.join(root, "apps/server"),
  );
  const archive = NodePath.join(
    dir,
    (await NodeFSP.readdir(dir)).find((name) => name.endsWith(".tgz")),
  );
  const digest = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(archive))
    .digest("hex");
  const controllerEnv = {
    ...base,
    ...credentials,
    ...awsEnv,
    ...tunnelDnsEnv,
    PORT: String(apiPort),
    NODE_ENV: "development",
    COMPADRE_SHUTDOWN_TIMEOUT_MS: "10000",
    TEMPORAL_SHUTDOWN_GRACE_TIME_MS: "5000",
    COMPADRE_DURABILITY_BACKEND: "postgres",
    COMPADRE_DURABILITY_DATABASE_URL: dbUrl,
    COMPADRE_T3_DIRECTORY_ENABLED: "true",
    COMPADRE_T3_API_ENABLED: "true",
    COMPADRE_T3_ARTIFACT_BUCKET: "compadre-e2e",
    COMPADRE_T3_ARTIFACT_REGION: "us-east-1",
    COMPADRE_T3_SLACK_ENABLED: "false",
    COMPADRE_DEV_ENVIRONMENT_ENABLED: "false",
    COMPADRE_API_KEY: apiKey,
    COMPADRE_AUTH_EXCHANGE_SECRET: exchange,
    SLACK_CLIENT_ID: "e2e-only",
    SLACK_CLIENT_SECRET: "e2e-only",
    COMPADRE_SLACK_WORKSPACE_ID: "T_E2E",
    COMPADRE_PUBLIC_URL: publicUrl,
    COMPADRE_MCP_ALLOW_PARTIAL: "true",
    COMPADRE_T3_PACKAGE_PATH: archive,
    COMPADRE_T3_MODAL_APP: session,
    COMPADRE_MODAL_APP: session,
    COMPADRE_MODAL_TIMEOUT_MS: "3600000",
    COMPADRE_MODAL_SNAPSHOT_TTL_MS: "3600000",
    GITHUB_REPO_URL: "https://github.com/octocat/Hello-World.git",
    REPO_BRANCH: "master",
    REPO_PATH: NodePath.join(dir, "repository"),
    TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
    TEMPORAL_NAMESPACE: session,
    DD_TRACE_ENABLED: "false",
    DD_LLMOBS_ENABLED: "0",
    DD_ENV: session,
  };
  await run("controller-build", "npm", ["run", "build:server"], controllerEnv, controller);
  await run("controller-migrations", "npm", ["run", "db:migrate"], controllerEnv, controller);
  const centralEnv = {
    ...base,
    ...awsEnv,
    ...tunnelDnsEnv,
    COMPADRE_T3_ATTACHMENT_BUCKET: "compadre-e2e",
    COMPADRE_T3_ATTACHMENT_REGION: "us-east-1",
    COMPADRE_T3_PERSISTENCE: "postgres",
    COMPADRE_T3_POSTGRES_URL: dbUrl,
    COMPADRE_T3_REACTOR_MODE: "single-process",
    COMPADRE_NATIVE_T3_URL: `http://127.0.0.1:${apiPort}/hosted/t3/chat`,
    COMPADRE_CONTROLLER_URL: `http://127.0.0.1:${apiPort}`,
    COMPADRE_API_KEY: apiKey,
    COMPADRE_AUTH_EXCHANGE_SECRET: exchange,
    VITE_COMPADRE_AUTH_ENABLED: "true",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_HOME: NodePath.join(dir, "central"),
    T3CODE_HOST: "127.0.0.1",
  };
  await run(
    "central-migrations",
    "node",
    ["apps/server/dist/bin.mjs", "migrate-postgres"],
    centralEnv,
  );
  const tokenResult = NodeChildProcess.spawnSync(
    "node",
    [
      "apps/server/dist/bin.mjs",
      "auth",
      "session",
      "issue",
      "--base-dir",
      centralEnv.T3CODE_HOME,
      "--label",
      session,
      "--ttl",
      "8h",
      "--token-only",
    ],
    {
      cwd: root,
      env: centralEnv,
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        NodeFS.openSync(NodePath.join(dir, "central-token.log"), "a", 0o600),
      ],
    },
  );
  if (tokenResult.status !== 0)
    throw new Error("Central token issuance failed; inspect its private log");
  controllerEnv.COMPADRE_T3_CENTRAL_TOKEN = issuedToken(tokenResult.stdout);
  const dev = start(
    "central",
    "vp",
    ["run", "dev", "--home-dir", centralEnv.T3CODE_HOME, "--port", String(serverPort)],
    centralEnv,
  );
  const webPort = await waitFor(
    "dev runner",
    async () => (await NodeFSP.readFile(dev.log, "utf8")).match(/webPort=(\d+)/)?.[1],
  );
  const webUrl = `http://localhost:${webPort}`;
  Object.assign(controllerEnv, {
    COMPADRE_T3_CENTRAL_URL: `http://127.0.0.1:${serverPort}`,
    COMPADRE_T3_HOSTED_APP_URL: webUrl,
  });
  await NodeFSP.writeFile(
    NodePath.join(dir, "private.json"),
    JSON.stringify({
      controller: controllerEnv,
      central: centralEnv,
      webUrl,
      composeEnv,
      composeArgs,
    }),
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(
    NodePath.join(dir, "manifest.json"),
    JSON.stringify(
      {
        root,
        session,
        webUrl,
        apiUrl: `http://127.0.0.1:${apiPort}`,
        workerArchiveSha256: digest,
        composeProject: session,
      },
      null,
      2,
    ),
  );
  start("controller", "node", ["--import", "tsx", "src/start.ts"], controllerEnv, controller);
  await waitFor("controller health", async () =>
    fetch(`http://127.0.0.1:${apiPort}/health`)
      .then((r) => r.ok)
      .catch(() => false),
  );
  await waitFor("central server", async () =>
    fetch(`http://127.0.0.1:${serverPort}/api/auth/session`)
      .then((r) => r.ok)
      .catch(() => false),
  );
  await run("fixture", "git", [
    "clone",
    "--depth",
    "1",
    "https://github.com/octocat/Hello-World.git",
    NodePath.join(dir, "repository"),
  ]);
  const seeded = await fetch(`http://127.0.0.1:${serverPort}/api/orchestration/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${controllerEnv.COMPADRE_T3_CENTRAL_TOKEN}`,
    },
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId: NodeCrypto.randomUUID(),
      title: "E2E fixture",
      workspaceRoot: NodePath.join(dir, "repository"),
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
      createdAt: new Date().toISOString(),
    }),
  });
  if (!seeded.ok) throw new Error(`Fixture project creation failed (${seeded.status})`);
  await waitFor("web", async () =>
    fetch(webUrl)
      .then((r) => r.ok)
      .catch(() => false),
  );
  console.log(
    `Ready: ${webUrl}\nLogin: node scripts/compadre-e2e.mjs login --state ${dir}\nKeep this process running; Ctrl-C stops its local services.`,
  );
} catch (error) {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
}
