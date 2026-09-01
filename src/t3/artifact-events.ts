import { SlackClient } from "../services/slack-client.js";
import type { StreamChunk } from "./agui-protocol.js";
import type { T3ArtifactStore } from "./artifact-store.js";
import type { T3GatewayTurn } from "./gateway.js";
import type { T3OutputArtifact } from "./output-artifacts.js";

export interface ArtifactCollectingGateway {
  collectOutputArtifacts?(
    turn: T3GatewayTurn,
    publish: (artifact: T3OutputArtifact) => Promise<void>,
  ): Promise<{
    published: Array<{ path: string; digest: string }>;
    failures: string[];
  }>;
}

export interface CollectNativeT3ArtifactEventsInput {
  gateway: ArtifactCollectingGateway;
  artifactStore: T3ArtifactStore;
  turn: T3GatewayTurn;
  runId: string;
  slackDestination?: {
    channelId: string;
    threadTs: string;
    recipientTeamId?: string;
  };
  botToken?: string;
}

/**
 * Publish the worker's /tmp/agent-outputs files to durable artifact storage
 * (and best-effort into the linked Slack thread) and return one
 * OUTPUT_ARTIFACT chunk per published file. Artifacts are content-addressed
 * by digest, so re-running collection after a driver retry re-publishes the
 * same bytes idempotently.
 */
export async function collectNativeT3ArtifactEvents(
  input: CollectNativeT3ArtifactEventsInput,
): Promise<StreamChunk[]> {
  if (!input.gateway.collectOutputArtifacts) return [];
  const events: StreamChunk[] = [];
  const slackTeamId =
    input.slackDestination?.recipientTeamId ??
    process.env.SLACK_TEAM_ID?.trim() ??
    process.env.COMPADRE_SLACK_WORKSPACE_ID?.trim();
  const collection = await input.gateway.collectOutputArtifacts(
    input.turn,
    async (artifact) => {
      const metadata = await input.artifactStore.publish({
        runId: input.runId,
        artifactId: artifact.digest,
        path: artifact.path,
        name: artifact.filename,
        title: artifact.title,
        mimetype: artifact.mimetype,
        bytes: artifact.bytes,
      });
      if (input.slackDestination && input.botToken && slackTeamId) {
        try {
          await new SlackClient({
            botToken: input.botToken,
            teamId: slackTeamId,
          }).uploadBytes({
            channel: input.slackDestination.channelId,
            threadTs: input.slackDestination.threadTs,
            data: artifact.bytes,
            filename: artifact.filename,
            title: artifact.title,
          });
        } catch (error) {
          console.warn("[t3-artifacts] Slack artifact delivery failed", {
            runId: input.runId,
            artifactId: metadata.artifactId,
            error,
          });
        }
      }
      events.push({
        type: "OUTPUT_ARTIFACT",
        timestamp: Date.now(),
        artifact: {
          artifactId: metadata.artifactId,
          path: metadata.path,
          name: metadata.name,
          title: metadata.title,
          mimetype: metadata.mimetype,
          sizeBytes: metadata.sizeBytes,
          storage: "hosted-object",
        },
      });
    },
  );
  for (const failure of collection.failures) {
    console.warn("[t3-artifacts] output artifact was not published", {
      runId: input.runId,
      failure,
    });
  }
  return events;
}
