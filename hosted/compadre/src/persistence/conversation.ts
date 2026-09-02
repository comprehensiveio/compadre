import crypto from "node:crypto";
import type { ModelMessage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineMessageStore,
  type ChatPersistence,
} from "@tanstack/ai-persistence";

/**
 * Keep provider-only Slack context out of canonical history while allowing a
 * native harness session to receive only the current turn.
 */
export async function createChannelConversationPersistence(
  persistence: ChatPersistence,
  options: {
    threadId: string;
    providerMessages: ModelMessage[];
    transcriptUserMessage: string;
    resumesNativeSession: boolean;
  },
): Promise<ChatPersistence> {
  const canonicalHistory = await persistence.stores.messages.loadThread(
    options.threadId,
  );
  const currentProviderMessage = options.providerMessages.at(-1);
  if (!currentProviderMessage) {
    throw new Error(
      "Channel conversation persistence requires a provider message",
    );
  }
  // Downstream middleware may remove old provider-bound messages (notably the
  // sandbox's recorded tool history), so the original prefix length is not a
  // stable turn boundary. Model message IDs survive those transforms and are
  // ignored by providers.
  const turnBoundaryId = `compadre-channel-turn:${crypto.randomUUID()}`;
  const providerMessages = [
    ...options.providerMessages.slice(0, -1),
    { ...currentProviderMessage, id: turnBoundaryId },
  ];
  const providerPrefix = options.resumesNativeSession
    ? providerMessages
    : [...canonicalHistory, ...providerMessages];
  const canonicalPendingTurn: ModelMessage = {
    role: "user",
    content: options.transcriptUserMessage,
  };

  const messages = defineMessageStore({
    async loadThread(threadId) {
      if (threadId !== options.threadId) {
        return persistence.stores.messages.loadThread(threadId);
      }
      return [...providerPrefix];
    },

    async saveThread(threadId, nextMessages) {
      if (threadId !== options.threadId) {
        await persistence.stores.messages.saveThread(threadId, nextMessages);
        return;
      }
      const turnBoundaryIndex = nextMessages.findIndex(
        (message) => message.id === turnBoundaryId,
      );
      if (turnBoundaryIndex < 0) {
        throw new Error(
          `Channel turn boundary was removed before persisting thread ${threadId}`,
        );
      }
      const completedCurrentTurn = nextMessages.slice(turnBoundaryIndex + 1);
      await persistence.stores.messages.saveThread(threadId, [
        ...canonicalHistory,
        canonicalPendingTurn,
        ...completedCurrentTurn,
      ]);
    },
  });

  return defineAIPersistence({
    stores: {
      ...persistence.stores,
      messages,
    },
  });
}
