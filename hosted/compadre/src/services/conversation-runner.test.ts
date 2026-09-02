import assert from "node:assert/strict";
import test from "node:test";
import { configuredConversationRunner } from "./conversation-runner.js";
import { runWorkflowConversation } from "./workflow-conversation.js";

test("always routes conversations through the durable controller", () => {
  assert.equal(configuredConversationRunner(), runWorkflowConversation);
});
