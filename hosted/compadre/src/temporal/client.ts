import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import Long from "long";
import {
  NATIVE_T3_TASK_QUEUE,
  temporalAddress,
  temporalNamespace,
} from "./shared.js";

let configuredClient: Promise<Client> | undefined;

const NAMESPACE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Register the Compadre namespace when it does not exist yet. Idempotent by
 * construction so every process can call it at startup; a self-hosted server
 * allows namespace registration, and the deployed namespace is created the
 * same way the local one is.
 */
export async function ensureTemporalNamespace(
  address: string = temporalAddress(),
  namespace: string = temporalNamespace(),
): Promise<void> {
  const connection = await Connection.connect({ address });
  try {
    await connection.workflowService.describeNamespace({ namespace });
  } catch {
    console.log(`[temporal] registering namespace ${namespace}`);
    await connection.workflowService
      .registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: {
          seconds: Long.fromNumber(NAMESPACE_RETENTION_SECONDS),
        },
      })
      .catch((error) => {
        // A concurrent process may have won the registration race.
        if (!String(error).includes("AlreadyExists")) throw error;
      });
    // Registration is asynchronous server-side: the namespace only becomes
    // usable after it propagates to every service's namespace cache. Wait
    // for visibility plus the server's cache refresh before first use.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await connection.workflowService.describeNamespace({ namespace });
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(
            `Temporal namespace ${namespace} did not become visible within 60s`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    console.log(`[temporal] namespace ${namespace} registered and visible`);
  } finally {
    await connection.close();
  }
}

export function getTemporalClient(): Promise<Client> {
  if (!configuredClient) {
    const initialization = (async () => {
      const address = temporalAddress();
      const namespace = temporalNamespace();
      await ensureTemporalNamespace(address, namespace);
      const connection = await Connection.connect({ address });
      console.log(`[temporal] client connected address=${address} namespace=${namespace}`);
      return new Client({ connection, namespace });
    })().catch((error) => {
      if (configuredClient === initialization) configuredClient = undefined;
      throw error;
    });
    configuredClient = initialization;
  }
  return configuredClient;
}

export function resetTemporalClientForTests(): void {
  configuredClient = undefined;
}

/**
 * Idempotently start the 6-hourly golden-template build cron. Failures here
 * never block startup: a missing schedule only means new threads cold-build,
 * which is the pre-template behavior.
 */
export async function ensureWorkerTemplateBuildSchedule(): Promise<void> {
  const client = await getTemporalClient();
  try {
    await client.workflow.start("t3WorkerTemplateBuildWorkflow", {
      workflowId: "t3-worker-template-build",
      taskQueue: NATIVE_T3_TASK_QUEUE,
      cronSchedule: "0 */6 * * *",
    });
    console.log("[temporal] worker-template build cron started");
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) return;
    throw error;
  }
}
