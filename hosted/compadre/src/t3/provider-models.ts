import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { CODEX_VERSION, CLAUDE_CODE_VERSION } from "./provider-versions.js";

const require = createRequire(import.meta.url);
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
    throw new Error("Unsupported Codex discovery platform");
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
const rpcResponse = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const modelPage = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullish(),
});

/** Discover with the same native RPC as T3, without creating a conversation or worker. */
export async function discoverCodexModels(
  environment: NodeJS.ProcessEnv = process.env,
  executable = bundledCodexExecutable(),
  args = ["app-server"],
) {
  const home = await mkdtemp(join(tmpdir(), "compadre-model-discovery-"));
  try {
    const key =
      environment.CODEX_API_KEY?.trim() || environment.OPENAI_API_KEY?.trim();
    if (!key)
      throw new Error(
        "Codex model discovery requires the worker API credential",
      );
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: key,
      }),
      { mode: 0o600 },
    );
    const child = spawn(executable, args, {
      cwd: home,
      env: { PATH: environment.PATH, HOME: home, CODEX_HOME: home },
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
        fail(new Error("Codex discovery process exited"));
        resolve();
      });
    });
    child.on("error", () => fail(new Error("Codex discovery process failed")));
    child.stdin.on("error", () =>
      fail(new Error("Codex discovery pipe failed")),
    );
    lines.on("line", (line) => {
      try {
        const response = rpcResponse.parse(JSON.parse(line));
        if (response.id === undefined) return;
        const waiter = pending.get(response.id);
        if (!waiter) return;
        pending.delete(response.id);
        if (response.error !== undefined)
          waiter.reject(new Error("Codex discovery RPC failed"));
        else waiter.resolve(response.result);
      } catch {
        fail(new Error("Invalid Codex discovery response"));
      }
    });
    const timer = setTimeout(() => {
      fail(new Error("Codex model discovery timed out"));
      child.kill("SIGKILL");
    }, 20_000);
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    try {
      await request("initialize", {
        clientInfo: { name: "compadre_models", version: "1" },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const data: Array<Record<string, unknown>> = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = modelPage.parse(
          await request("model/list", cursor ? { cursor } : {}),
        );
        data.push(...page.data);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Repeated Codex model cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!data.length)
        throw new Error("Codex returned an empty model catalog");
      return { version: CODEX_VERSION, data, nextCursor: null };
    } finally {
      clearTimeout(timer);
      lines.close();
      child.kill("SIGKILL");
      await closed;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Coalesce concurrent probes and retain the last successful catalog during outages. */
export function makeProviderModelDiscovery(
  probe = discoverCodexModels,
  now = Date.now,
) {
  let cached: Awaited<ReturnType<typeof discoverCodexModels>> | undefined;
  let expiresAt = 0;
  let pending:
    | Promise<Awaited<ReturnType<typeof discoverCodexModels>>>
    | undefined;
  return async () => {
    if (cached && now() < expiresAt) return cached;
    pending ??= probe()
      .then((result) => {
        cached = result;
        expiresAt = now() + 5 * 60_000;
        return result;
      })
      .catch((error: unknown) => {
        if (!cached) throw error;
        expiresAt = now() + 30_000;
        return cached;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

export const discoverProviderModels = makeProviderModelDiscovery();
export const claudeProviderVersion = { version: CLAUDE_CODE_VERSION };
