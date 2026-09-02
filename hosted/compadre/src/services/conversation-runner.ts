import type { runConversation } from "../conversation.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

export type ConversationRunner = typeof runConversation;

/** Keep the delivery channel independent from the agent execution topology. */
export function configuredConversationRunner(): ConversationRunner {
  return runWorkflowConversation;
}
