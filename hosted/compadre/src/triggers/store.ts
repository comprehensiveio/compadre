import { desc, eq, sql } from "drizzle-orm";
import type { CompadreDatabase } from "../db/client.js";
import { triggeredPrompts } from "../db/schema.js";
import type {
  CronTriggerConfig,
  TriggeredPromptInput,
  TriggeredPromptRecord,
  TriggerType,
} from "./types.js";

type TriggeredPromptRow = typeof triggeredPrompts.$inferSelect;

function rowToRecord(row: TriggeredPromptRow): TriggeredPromptRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    triggerType: row.triggerType as TriggerType,
    triggerConfig: row.triggerConfig,
    deliveryMode: row.deliveryMode,
    ...(row.slackChannelId === null ? {} : { slackChannelId: row.slackChannelId }),
    ...(row.targetThreadId === null ? {} : { targetThreadId: row.targetThreadId }),
    enabled: row.enabled,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.lastFiredAt === null ? {} : { lastFiredAt: row.lastFiredAt.toISOString() }),
    ...(row.lastCentralThreadId === null
      ? {}
      : { lastCentralThreadId: row.lastCentralThreadId }),
  };
}

function inputColumns(input: TriggeredPromptInput) {
  const triggerConfig: CronTriggerConfig = {
    cronExpression: input.cronExpression,
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
  return {
    name: input.name,
    prompt: input.prompt,
    triggerType: input.triggerType,
    triggerConfig,
    deliveryMode: input.deliveryMode,
    slackChannelId: input.slackChannelId ?? null,
    targetThreadId: input.targetThreadId ?? null,
    enabled: input.enabled,
  };
}

/** The store surface routes and activities depend on (fakeable in tests). */
export interface TriggeredPromptStoreApi {
  create(input: TriggeredPromptInput): Promise<TriggeredPromptRecord>;
  update(
    id: string,
    input: TriggeredPromptInput,
  ): Promise<TriggeredPromptRecord | null>;
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<TriggeredPromptRecord | null>;
  get(id: string): Promise<TriggeredPromptRecord | null>;
  list(): Promise<TriggeredPromptRecord[]>;
  delete(id: string): Promise<boolean>;
  recordFired(id: string, result: { centralThreadId: string }): Promise<void>;
}

/** Postgres is the source of truth; Temporal Schedules mirror these rows. */
export class TriggeredPromptStore implements TriggeredPromptStoreApi {
  constructor(private readonly db: CompadreDatabase) {}

  async create(input: TriggeredPromptInput): Promise<TriggeredPromptRecord> {
    const [row] = await this.db
      .insert(triggeredPrompts)
      .values({
        ...inputColumns(input),
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return rowToRecord(row!);
  }

  async update(
    id: string,
    input: TriggeredPromptInput,
  ): Promise<TriggeredPromptRecord | null> {
    const [row] = await this.db
      .update(triggeredPrompts)
      .set({
        ...inputColumns(input),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(triggeredPrompts.id, id))
      .returning();
    return row ? rowToRecord(row) : null;
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<TriggeredPromptRecord | null> {
    const [row] = await this.db
      .update(triggeredPrompts)
      .set({ enabled, updatedAt: sql`now()` })
      .where(eq(triggeredPrompts.id, id))
      .returning();
    return row ? rowToRecord(row) : null;
  }

  async get(id: string): Promise<TriggeredPromptRecord | null> {
    const [row] = await this.db
      .select()
      .from(triggeredPrompts)
      .where(eq(triggeredPrompts.id, id));
    return row ? rowToRecord(row) : null;
  }

  async list(): Promise<TriggeredPromptRecord[]> {
    const rows = await this.db
      .select()
      .from(triggeredPrompts)
      .orderBy(desc(triggeredPrompts.createdAt));
    return rows.map(rowToRecord);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(triggeredPrompts)
      .where(eq(triggeredPrompts.id, id))
      .returning({ id: triggeredPrompts.id });
    return deleted.length > 0;
  }

  async recordFired(
    id: string,
    result: { centralThreadId: string },
  ): Promise<void> {
    // same_thread continuity lives in the central thread (stable per-trigger
    // conversation key) and the hosted Slack binding, not on this row.
    await this.db
      .update(triggeredPrompts)
      .set({
        lastFiredAt: sql`now()`,
        lastCentralThreadId: result.centralThreadId,
      })
      .where(eq(triggeredPrompts.id, id));
  }
}

export async function getConfiguredTriggeredPromptStore(): Promise<TriggeredPromptStore | null> {
  const { getConfiguredThreadPersistence } = await import(
    "../persistence/runtime.js"
  );
  const runtime = await getConfiguredThreadPersistence();
  if (!runtime?.database) return null;
  return new TriggeredPromptStore(runtime.database);
}
