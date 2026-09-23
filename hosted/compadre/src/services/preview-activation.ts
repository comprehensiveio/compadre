import crypto from "node:crypto";
import { log } from "../logging.js";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  InMemoryLockStore,
  type LockStore,
  type MetadataStore,
} from "../t3/storage.js";
import { getTemporalClient } from "../temporal/client.js";
import {
  NATIVE_T3_TASK_QUEUE,
  previewActivationWorkflowId,
  type PreviewActivationWorkflowInput,
} from "../temporal/shared.js";

const NAMESPACE = "compadre.t3.preview-activations.v1";

export type PreviewActivationPhase =
  | "requested"
  | "restoring"
  | "starting"
  | "ready"
  | "failed";

export interface PreviewActivationRecord {
  canonicalThreadId: string;
  activationId: string;
  phase: PreviewActivationPhase;
  /** Optional for activations written before startup timing was introduced. */
  requestedAt?: string;
  updatedAt: string;
  error?: string;
}

function decodeRecord(
  canonicalThreadId: string,
  value: unknown,
): PreviewActivationRecord {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid preview activation for ${canonicalThreadId}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.canonicalThreadId !== canonicalThreadId ||
    typeof record.activationId !== "string" ||
    !["requested", "restoring", "starting", "ready", "failed"].includes(
      String(record.phase),
    ) ||
    typeof record.updatedAt !== "string" ||
    (record.requestedAt !== undefined &&
      (typeof record.requestedAt !== "string" ||
        !Number.isFinite(Date.parse(record.requestedAt)))) ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new Error(`Invalid preview activation for ${canonicalThreadId}`);
  }
  return record as unknown as PreviewActivationRecord;
}

export class PreviewActivationStore {
  constructor(
    private readonly metadata: MetadataStore,
    private readonly now: () => Date = () => new Date(),
    private readonly locks: LockStore = new InMemoryLockStore(),
  ) {}

  private lockKey(canonicalThreadId: string): string {
    return `compadre:t3-preview-activation-state:${canonicalThreadId}`;
  }

  async get(
    canonicalThreadId: string,
  ): Promise<PreviewActivationRecord | null> {
    const value = await this.metadata.get(NAMESPACE, canonicalThreadId);
    return value === null ? null : decodeRecord(canonicalThreadId, value);
  }

  async create(
    canonicalThreadId: string,
    activationId: string,
  ): Promise<PreviewActivationRecord> {
    return this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const timestamp = this.now().toISOString();
        const record: PreviewActivationRecord = {
          canonicalThreadId,
          activationId,
          phase: "requested",
          requestedAt: timestamp,
          updatedAt: timestamp,
        };
        await this.metadata.set(NAMESPACE, canonicalThreadId, record);
        log.info({ event: "preview.activation.requested", canonicalThreadId, activationId },
          "Preview activation requested");
        return record;
      },
    );
  }

  async update(
    canonicalThreadId: string,
    activationId: string,
    phase: PreviewActivationPhase,
    error?: string,
  ): Promise<PreviewActivationRecord | null> {
    return this.locks.withLock(
      this.lockKey(canonicalThreadId),
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const current = await this.get(canonicalThreadId);
        if (!current || current.activationId !== activationId) return null;
        // Temporal can redeliver an activity. Do not reset a phase's clock or
        // count the same terminal outcome twice.
        if (current.phase === phase || current.phase === "ready" || current.phase === "failed") {
          return current;
        }
        const record: PreviewActivationRecord = {
          canonicalThreadId,
          activationId,
          phase,
          ...(current.requestedAt ? { requestedAt: current.requestedAt } : {}),
          updatedAt: this.now().toISOString(),
          ...(error ? { error } : {}),
        };
        await this.metadata.set(NAMESPACE, canonicalThreadId, record);
        const elapsed = (since: string) => Math.max(0, Date.parse(record.updatedAt) - Date.parse(since));
        log.info({
          event: "preview.activation.transition",
          canonicalThreadId,
          activationId,
          phase,
          previousPhase: current.phase,
          phaseDurationMs: elapsed(current.updatedAt),
          ...(record.requestedAt ? { elapsedMs: elapsed(record.requestedAt) } : {}),
        }, "Preview activation phase completed");
        return record;
      },
    );
  }
}

export interface PreviewActivationWorkflowLauncher {
  start(input: PreviewActivationWorkflowInput): Promise<void>;
}

export function createPreviewActivationWorkflowLauncher(
  getClient: typeof getTemporalClient = getTemporalClient,
): PreviewActivationWorkflowLauncher {
  return {
    async start(input) {
      const client = await getClient();
      try {
        await client.workflow.start("previewActivationWorkflow", {
          taskQueue: NATIVE_T3_TASK_QUEUE,
          workflowId: previewActivationWorkflowId(input.activationId),
          args: [input],
        });
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return;
        throw error;
      }
    },
  };
}

export class PreviewActivationService {
  constructor(
    private readonly store: PreviewActivationStore,
    private readonly locks: LockStore,
    private readonly launcher: PreviewActivationWorkflowLauncher = createPreviewActivationWorkflowLauncher(),
    private readonly idFactory: () => string = crypto.randomUUID,
  ) {}

  status(canonicalThreadId: string): Promise<PreviewActivationRecord | null> {
    return this.store.get(canonicalThreadId);
  }

  start(canonicalThreadId: string): Promise<PreviewActivationRecord> {
    return this.locks.withLock(
      `compadre:t3-preview-activation:${canonicalThreadId}`,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        const current = await this.store.get(canonicalThreadId);
        const record =
          current &&
          ["requested", "restoring", "starting"].includes(current.phase)
            ? current
            : await this.store.create(canonicalThreadId, this.idFactory());
        await this.launcher.start({
          canonicalThreadId,
          activationId: record.activationId,
        });
        return record;
      },
    );
  }
}
