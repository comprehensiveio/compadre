import assert from "node:assert/strict";
import test from "node:test";
import { runConversation } from "../conversation.js";
import { configuredConversationRunner } from "./conversation-runner.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

test("keeps Slack on the persistent runner by default", () => {
  assert.equal(configuredConversationRunner({}), runConversation);
});

test("selects the durable Workflow producer only when explicitly enabled", () => {
  assert.equal(
    configuredConversationRunner({ COMPADRE_SLACK_WORKFLOW_ENABLED: "true" }),
    runWorkflowConversation,
  );
});
