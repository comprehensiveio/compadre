import crypto from "node:crypto";
import { z } from "zod";
import {
  EventType,
  isTerminalRunStatus,
  type StreamChunk,
} from "@tanstack/ai";
import {
  getConfiguredAgentRunDurability,
  type AgentRunDurability,
} from "../durability/runtime.js";

export const durabilityProbeInputSchema = z.object({
  runId: z.string().trim().min(1),
  expectedText: z.string().optional(),
});

export interface DurabilityProbeResult {
  backend: AgentRunDurability["backend"];
  runId: string;
  threadId: string;
  status: string;
  hasFinishedAt: boolean;
  hasError: boolean;
  snapshotEventCount: number;
  replayEventCount: number;
  replayMatchesSnapshot: boolean;
  eventTypes: string[];
  replayedTextSha256: string;
  expectedTextMatches: boolean | null;
}

export interface DurabilityProbeDependencies {
  getDurability(): Promise<AgentRunDurability | null>;
}

const defaultDependencies: DurabilityProbeDependencies = {
  getDurability: getConfiguredAgentRunDurability,
};

function textFrom(chunks: StreamChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((chunk) => chunk.delta)
    .join("");
}

/**
 * Read a completed run through the production durability contracts from inside
 * Render's private network. The result proves replay without returning agent
 * content or database credentials to the caller.
 */
export async function executeDurabilityProbe(
  rawInput: unknown,
  dependencies: DurabilityProbeDependencies = defaultDependencies,
): Promise<DurabilityProbeResult> {
  const input = durabilityProbeInputSchema.parse(rawInput);
  const durability = await dependencies.getDurability();
  if (!durability) {
    throw new Error("Agent run durability is not configured");
  }

  const run = await durability.runs.get(input.runId);
  if (!run) throw new Error(`Durable run ${input.runId} was not found`);
  if (!isTerminalRunStatus(run.status)) {
    throw new Error(
      `Durable run ${input.runId} is ${run.status}; replay requires a terminal run`,
    );
  }

  const snapshot = await durability.stream(input.runId).snapshot();
  const replay: typeof snapshot = [];
  const replaySignal = AbortSignal.timeout(60_000);
  for await (const entry of durability
    .stream(input.runId)
    .read("-1", replaySignal)) {
    replay.push(entry);
  }

  const replayedChunks = replay.map((entry) => entry.chunk);
  const replayedText = textFrom(replayedChunks);
  return {
    backend: durability.backend,
    runId: run.runId,
    threadId: run.threadId,
    status: run.status,
    hasFinishedAt: run.finishedAt !== undefined,
    hasError: run.error !== undefined,
    snapshotEventCount: snapshot.length,
    replayEventCount: replay.length,
    replayMatchesSnapshot:
      JSON.stringify(replay) === JSON.stringify(snapshot),
    eventTypes: replayedChunks.map((chunk) => chunk.type),
    replayedTextSha256: crypto
      .createHash("sha256")
      .update(replayedText)
      .digest("hex"),
    expectedTextMatches:
      input.expectedText === undefined
        ? null
        : replayedText === input.expectedText,
  };
}
