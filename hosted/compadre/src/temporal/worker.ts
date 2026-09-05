import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
} from "@temporalio/worker";
import * as activities from "./activities.js";
import { ensureTemporalNamespace } from "./client.js";
import {
  NATIVE_T3_TASK_QUEUE,
  temporalAddress,
  temporalNamespace,
} from "./shared.js";

/**
 * Keep the worker drain window below the controller's HTTP drain
 * (COMPADRE_SHUTDOWN_TIMEOUT_MS = 295s) and Render's 300s shutdown cap. An
 * activity that cannot finish inside the window is retried by the replacement
 * instance and resumes from the durable event log.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 280_000;

export interface RunningTemporalWorker {
  worker: Worker;
  done: Promise<void>;
  shutdown(): Promise<void>;
}

function shutdownGraceMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.TEMPORAL_SHUTDOWN_GRACE_TIME_MS?.trim();
  if (!raw) return DEFAULT_SHUTDOWN_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("TEMPORAL_SHUTDOWN_GRACE_TIME_MS must be a positive number");
  }
  return value;
}

async function workflowBundle(): Promise<{ code: string }> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  // Production: the bundle is built at compile time (npm run build) so the
  // deployed workflow code is frozen with the image.
  const prebuilt = path.resolve(directory, "../temporal-workflow-bundle.js");
  if (fs.existsSync(prebuilt)) {
    return { code: fs.readFileSync(prebuilt, "utf-8") };
  }
  // Local tsx development bundles the TypeScript source on demand.
  const bundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(directory, "./workflows.ts"),
  });
  return { code: bundle.code };
}

export async function startNativeT3TemporalWorker(): Promise<RunningTemporalWorker> {
  const address = temporalAddress();
  const namespace = temporalNamespace();
  await ensureTemporalNamespace(address, namespace);
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: NATIVE_T3_TASK_QUEUE,
    workflowBundle: await workflowBundle(),
    maxHeartbeatThrottleInterval: "1 second",
    activities,
    shutdownGraceTime: shutdownGraceMs(),
  });
  console.log(
    `[temporal] worker started taskQueue=${NATIVE_T3_TASK_QUEUE} namespace=${namespace}`,
  );
  const done = worker.run();
  return {
    worker,
    done,
    async shutdown() {
      worker.shutdown();
      await done;
      await connection.close().catch(() => undefined);
    },
  };
}
