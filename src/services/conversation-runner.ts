import { runConversation } from "../conversation.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

export type ConversationRunner = typeof runConversation;

/** Keep the delivery channel independent from the agent execution topology. */
export function configuredConversationRunner(
  environment: NodeJS.ProcessEnv = process.env,
): ConversationRunner {
  return environment.COMPADRE_SLACK_WORKFLOW_ENABLED === "true"
    ? runWorkflowConversation
    : runConversation;
}
