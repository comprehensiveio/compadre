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
  const providerPrefix = options.resumesNativeSession
    ? options.providerMessages
    : [...canonicalHistory, ...options.providerMessages];
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
      const completedCurrentTurn = nextMessages.slice(providerPrefix.length);
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
