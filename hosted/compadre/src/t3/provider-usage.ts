import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { CodexSubscriptionLane } from "./codex-subscription-lane.js";

const require = createRequire(import.meta.url);
const rpcResponse = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

function bundledCodexExecutable() {
  const architecture =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : undefined;
  const suffix =
    process.platform === "linux"
      ? "unknown-linux-musl"
      : process.platform === "darwin"
        ? "apple-darwin"
        : process.platform === "win32"
          ? "pc-windows-msvc"
          : undefined;
  if (!architecture || !suffix)
    throw new Error("Unsupported Codex usage platform");
  const root = dirname(
    require.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    ),
  );
  return join(
    root,
    "vendor",
    `${architecture}-${suffix}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

/** Read the shared ChatGPT account without claiming or waking a thread worker. */
export async function discoverCodexSubscriptionUsage(
  lane: CodexSubscriptionLane,
  executable = bundledCodexExecutable(),
  args = ["app-server"],
) {
  const result = await lane.withIdleAuth(
    async (authJson, persistRefreshedAuth) => {
      const home = await mkdtemp(join(tmpdir(), "compadre-usage-discovery-"));
      try {
        const authPath = join(home, "auth.json");
        await writeFile(authPath, authJson, { mode: 0o600 });
        const child = spawn(executable, args, {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
          stdio: ["pipe", "pipe", "ignore"],
        });
        const lines = createInterface({ input: child.stdout });
        const pending = new Map<
          number,
          { resolve(value: unknown): void; reject(error: Error): void }
        >();
        let nextId = 0;
        let failure: Error | undefined;
        const fail = (error: Error) => {
          failure = error;
          for (const waiter of pending.values()) waiter.reject(error);
          pending.clear();
        };
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => {
            fail(new Error("Codex usage process exited"));
            resolve();
          });
        });
        child.on("error", () => fail(new Error("Codex usage process failed")));
        child.stdin.on("error", () =>
          fail(new Error("Codex usage pipe failed")),
        );
        lines.on("line", (line) => {
          try {
            const response = rpcResponse.parse(JSON.parse(line));
            if (response.id === undefined) return;
            const waiter = pending.get(response.id);
            if (!waiter) return;
            pending.delete(response.id);
            if (response.error !== undefined)
              waiter.reject(new Error("Codex usage RPC failed"));
            else waiter.resolve(response.result);
          } catch {
            fail(new Error("Invalid Codex usage response"));
          }
        });
        const timer = setTimeout(() => {
          fail(new Error("Codex usage discovery timed out"));
          child.kill("SIGKILL");
        }, 10_000);
        const request = (method: string, params: unknown) =>
          new Promise<unknown>((resolve, reject) => {
            if (failure) return reject(failure);
            const id = nextId++;
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
          });
        try {
          await request("initialize", {
            clientInfo: { name: "compadre_usage", version: "1" },
          });
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          const [account, rateLimits] = await Promise.all([
            request("account/read", {}),
            request("account/rateLimits/read", undefined),
          ]);
          return { account, rateLimits };
        } finally {
          clearTimeout(timer);
          lines.close();
          child.kill("SIGKILL");
          await closed;
          await persistRefreshedAuth(await readFile(authPath, "utf8"));
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
  return result.status === "available"
    ? { subscription: { status: "idle" as const }, ...result.value }
    : { subscription: { status: result.status } };
}
