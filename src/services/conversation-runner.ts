import { runConversation } from "../conversation.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

export type ConversationRunner = typeof runConversation;

export function validateRelayOnlyConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.COMPADRE_RELAY_ONLY === "true" &&
    environment.COMPADRE_SLACK_WORKFLOW_ENABLED !== "true"
  ) {
    throw new Error(
      "COMPADRE_RELAY_ONLY requires COMPADRE_SLACK_WORKFLOW_ENABLED=true",
    );
  }
}

/** Keep the delivery channel independent from the agent execution topology. */
export function configuredConversationRunner(
  environment: NodeJS.ProcessEnv = process.env,
): ConversationRunner {
  return environment.COMPADRE_SLACK_WORKFLOW_ENABLED === "true"
    ? runWorkflowConversation
    : runConversation;
}
