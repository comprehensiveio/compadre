import { modalSandboxProvider } from "../tanstack/modal-sandbox.js";
import { authenticatedDevPreviewUrl } from "../t3/dev-environment.js";
import type { T3ThreadBinding } from "./t3-thread-bindings.js";

export interface ThreadEnvironmentObservation {
  container: "running" | "stopped" | "unknown";
  devServer: "ready" | "stopped" | "unresponsive" | "unknown";
  database: "ready" | "stopped" | "unknown";
  checkedAt?: string;
  previewUrl?: string;
}

// Read only localhost readiness. Never invoke setup, restore, or preview activation.
export const ENVIRONMENT_PROBE = `python3 - <<'PY'
import json, socket, urllib.request, urllib.error, subprocess
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
try:
    response = opener.open('http://127.0.0.1:3000/', timeout=2)
    web = 'ready' if response.status < 400 else 'unresponsive'
except urllib.error.HTTPError as error:
    web = 'ready' if 300 <= error.code < 400 else 'unresponsive'
except Exception:
    try:
        with socket.create_connection(('127.0.0.1', 3000), timeout=1): pass
        web = 'unresponsive'
    except Exception: web = 'stopped'
try:
    result = subprocess.run(['pg_isready', '-q', '-h', '127.0.0.1', '-p', '5433', '-t', '2'], timeout=3)
    db = 'ready' if result.returncode == 0 else 'stopped' if result.returncode in (1, 2) else 'unknown'
except Exception: db = 'unknown'
print(json.dumps({'devServer': web, 'database': db}))
PY`;

export async function inspectThreadEnvironment(
  binding: T3ThreadBinding,
): Promise<ThreadEnvironmentObservation> {
  const handle = await modalSandboxProvider().resume({ id: binding.sandboxId });
  if (!handle)
    return {
      container: "stopped",
      devServer: "stopped",
      database: "stopped",
      checkedAt: new Date().toISOString(),
    };
  const result = await handle.process.exec(ENVIRONMENT_PROBE);
  const raw: unknown = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    container: "running",
    devServer:
      data.devServer === "ready" ||
      data.devServer === "stopped" ||
      data.devServer === "unresponsive"
        ? data.devServer
        : "unknown",
    database:
      data.database === "ready" || data.database === "stopped"
        ? data.database
        : "unknown",
    checkedAt: new Date().toISOString(),
  };
}

/** Cached observations never delay the directory or extend a worker's lease. */
export function createEnvironmentObserver(
  inspect = inspectThreadEnvironment,
  now = Date.now,
) {
  const cache = new Map<
    string,
    {
      value: ThreadEnvironmentObservation;
      refreshedAt: number;
      pending: boolean;
    }
  >();
  let inFlight = 0;
  return (bindings: readonly T3ThreadBinding[]) => {
    const keys = new Set(
      bindings.map(
        (binding) =>
          `${binding.sandboxId}:${binding.workerGeneration ?? 1}:${binding.workerState}`,
      ),
    );
    for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    const ordered = [...bindings].sort((left, right) => {
      const age = (binding: T3ThreadBinding) =>
        cache.get(
          `${binding.sandboxId}:${binding.workerGeneration ?? 1}:${binding.workerState}`,
        )?.refreshedAt ?? -Infinity;
      return age(left) - age(right);
    });
    return new Map(
      ordered.map((binding) => {
        const previewUrl = authenticatedDevPreviewUrl({
          ...process.env,
          COMPADRE_CANONICAL_THREAD_ID: binding.canonicalThreadId,
        });
        const key = `${binding.sandboxId}:${binding.workerGeneration ?? 1}:${binding.workerState}`;
        let entry = cache.get(key);
        if (!entry) {
          entry = {
            value: {
              container: "unknown",
              devServer: "unknown",
              database: "unknown",
            },
            refreshedAt: -Infinity,
            pending: false,
          };
          cache.set(key, entry);
        }
        if (binding.workerState === "suspended") {
          return [
            binding.canonicalThreadId,
            {
              container: "stopped",
              devServer: "stopped",
              database: "stopped",
              ...(previewUrl ? { previewUrl } : {}),
            } satisfies ThreadEnvironmentObservation,
          ] as const;
        }
        if (
          binding.workerState !== "hibernating" &&
          binding.workerState !== "restoring" &&
          !entry.pending &&
          now() - entry.refreshedAt >= 30_000 &&
          inFlight < 4
        ) {
          const target = entry;
          target.pending = true;
          inFlight++;
          void inspect(binding)
            .then(
              (value) => {
                target.value = value;
              },
              () => {
                target.value = {
                  container: "unknown",
                  devServer: "unknown",
                  database: "unknown",
                  checkedAt: new Date(now()).toISOString(),
                };
              },
            )
            .finally(() => {
              target.refreshedAt = now();
              target.pending = false;
              inFlight--;
            });
        }
        return [
          binding.canonicalThreadId,
          { ...entry.value, ...(previewUrl ? { previewUrl } : {}) },
        ] as const;
      }),
    );
  };
}
