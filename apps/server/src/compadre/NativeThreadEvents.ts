import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationEvent,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

export const NativeThreadEventBatch = Schema.Struct({
  version: Schema.Literal(1),
  sourceThreadId: ThreadId,
  epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  events: Schema.Array(OrchestrationEvent).check(Schema.isMaxLength(128)),
});

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));

export const nativeId = (sourceThreadId: string, id: string) =>
  `compadre-native:${encodeURIComponent(sourceThreadId)}:${id}`;

/** Preserve T3's event payloads; only environment-local identities change at this boundary. */
export function mapNativeThreadEvent(
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  event: OrchestrationEvent,
  epoch: number,
): Extract<OrchestrationCommand, { type: "thread.native-event.apply" }> | null {
  if (
    event.aggregateKind !== "thread" ||
    event.aggregateId !== sourceThreadId ||
    !("threadId" in event.payload) ||
    event.payload.threadId !== sourceThreadId
  ) {
    throw new Error("Native event does not belong to the bound source thread.");
  }
  const id = (value: string) => nativeId(sourceThreadId, value);
  const turnId = (value: TurnId | null) => (value === null ? null : TurnId.make(id(value)));
  let mapped: OrchestrationEvent;
  const base = {
    ...event,
    eventId: EventId.make(id(event.eventId)),
    aggregateId: threadId,
    causationEventId:
      event.causationEventId === null ? null : EventId.make(id(event.causationEventId)),
    correlationId: null,
    metadata: { ...event.metadata, adapterKey: "compadre-native" },
  };
  switch (event.type) {
    case "thread.message-sent":
      if (event.payload.role !== "assistant" && event.payload.role !== "reasoning") return null;
      mapped = {
        ...base,
        type: event.type,
        payload: {
          ...event.payload,
          threadId,
          messageId: MessageId.make(id(event.payload.messageId)),
          turnId: turnId(event.payload.turnId),
        },
      };
      break;
    case "thread.session-set":
      if (event.payload.session.threadId !== sourceThreadId) {
        throw new Error("Native session does not belong to the source thread.");
      }
      mapped = {
        ...base,
        type: event.type,
        payload: {
          threadId,
          session: {
            ...event.payload.session,
            threadId,
            activeTurnId: turnId(event.payload.session.activeTurnId),
          },
        },
      };
      break;
    case "thread.activity-appended": {
      const { sequence: _sequence, ...activity } = event.payload.activity;
      const payload = activity.payload;
      // Request IDs are routed back to this worker on approval/question submission.
      const mappedPayload =
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        "requestId" in payload &&
        typeof payload.requestId === "string"
          ? { ...payload, requestId: id(payload.requestId) }
          : payload;
      mapped = {
        ...base,
        type: event.type,
        payload: {
          threadId,
          activity: {
            ...activity,
            id: EventId.make(id(activity.id)),
            turnId: turnId(activity.turnId),
            payload: mappedPayload,
          },
        },
      };
      break;
    }
    case "thread.proposed-plan-upserted":
      mapped = {
        ...base,
        type: event.type,
        payload: {
          threadId,
          proposedPlan: {
            ...event.payload.proposedPlan,
            id: id(event.payload.proposedPlan.id),
            turnId: turnId(event.payload.proposedPlan.turnId),
          },
        },
      };
      break;
    case "thread.turn-diff-completed":
      mapped = {
        ...base,
        type: event.type,
        payload: {
          ...event.payload,
          status: event.payload.checkpointRef.startsWith("compadre-review:")
            ? event.payload.status
            : "missing",
          threadId,
          turnId: TurnId.make(id(event.payload.turnId)),
          assistantMessageId:
            event.payload.assistantMessageId === null
              ? null
              : MessageId.make(id(event.payload.assistantMessageId)),
        },
      };
      break;
    // Central ingress owns projects, thread lifecycle, user preferences, and execution intent.
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "thread.created":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.auto-settle-set":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.reverted":
    case "thread.session-stop-requested":
      return null;
    case "thread.meta-updated": {
      const { branch, branchPullRequest, updatedAt } = event.payload;
      if (branch === undefined && branchPullRequest === undefined) return null;
      // Checkout observations travel upstream; paths, titles and explicit links do not.
      // The decider replaces the discovered PR's worker project ID with its central owner.
      mapped = {
        ...base,
        type: event.type,
        payload: {
          threadId,
          ...(branch !== undefined ? { branch } : {}),
          ...(branchPullRequest !== undefined ? { branchPullRequest } : {}),
          updatedAt,
        },
      };
      break;
    }
    // Hosted PR tools write directly to central storage so browser and agent edits agree.
    // Worker sync reactors (including old/restored journals) cannot overwrite that state.
    case "thread.pull-request-linked":
    case "thread.pull-request-unlinked":
    case "thread.pull-request-synced":
      return null;
    default:
      event satisfies never;
      throw new Error("Unclassified native T3 event; review hosted ownership before importing it.");
  }
  // Changed data for an existing source event gets a different command ID but
  // collides on the immutable event ID, so storage rejects conflicting replay.
  const digest = NodeCrypto.createHash("sha256").update(encodeEvent(mapped)).digest("hex");
  return {
    type: "thread.native-event.apply",
    threadId,
    sourceThreadId,
    epoch,
    event: mapped,
    commandId: CommandId.make(`${id(event.eventId)}:${digest}`),
  };
}
