import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const createdAt = "2026-09-10T12:00:00.000Z";
const threadId = ThreadId.make("thread-actions");
const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  updatedAt: createdAt,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Existing conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      pullRequests: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
};

it.layer(NodeServices.layer)("provider action admission", (it) => {
  for (const text of ["/compact", "normal conversation"]) {
    it.effect(`classifies ${text} before hidden prompt expansion`, () =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command"),
            threadId,
            message: {
              messageId: MessageId.make("message"),
              role: "user",
              text,
              providerPrompt: "Trusted metadata and expanded context",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          },
        });
        const event = (Array.isArray(result) ? result : [result]).find(
          (event) => event.type === "thread.turn-start-requested",
        );
        expect(event?.type).toBe("thread.turn-start-requested");
        if (event?.type === "thread.turn-start-requested") {
          expect(event.payload.providerAction).toEqual(
            text === "/compact" ? { type: "compact" } : undefined,
          );
        }
      }),
    );
  }

  it.effect("rejects attachments rather than treating an action as a prompt", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command"),
            threadId,
            providerAction: { type: "compact" },
            message: {
              messageId: MessageId.make("message"),
              role: "user",
              text: "/compact",
              attachments: [
                {
                  type: "file",
                  id: "attachment",
                  name: "file.txt",
                  mimeType: "text/plain",
                  sizeBytes: 1,
                },
              ],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
