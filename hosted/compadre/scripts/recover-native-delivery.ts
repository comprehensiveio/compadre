import { getConfiguredNativeT3RunDriverDependencies, getConfiguredNativeThreadDelivery, getConfiguredT3Gateway } from "../src/t3/runtime.js";

// Use the controller's configured environment. Never load a local production env file implicitly.
const threadId = process.argv[2];
if (!threadId || !/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error("Usage: recover-native-delivery.ts <canonical-thread-id>");
const deps = await getConfiguredNativeT3RunDriverDependencies();
const delivery = await getConfiguredNativeThreadDelivery();
const gateway = await getConfiguredT3Gateway();
if (!deps || !delivery || !gateway) throw new Error("Native delivery is not configured");
const before = await delivery.get(threadId);
if (!before?.runId) throw new Error("No saved delivery run/cursor; refusing to create a conversation");
const request = await deps.requests.getRequest(before.runId, { includeInputFiles: false });
if (!request || request.canonicalThreadId !== threadId) throw new Error("Saved delivery request does not match the thread");
await gateway.recoverNativeDelivery(threadId, async (connection) => {
  // Reuse the normal adoption/restore path under the same lock as provider dispatch.
  // No startTurn, lifecycle rerun, or Slack send is issued here.
  await deps.prepareNativeDelivery(request, connection);
});
const after = await delivery.get(threadId);
console.log(JSON.stringify({ threadId, runId: before.runId, beforeEpoch: before.epoch,
  epoch: after?.epoch, sandboxId: after?.sandboxId, cursor: after?.offset, recoveryStarted: true }));
process.exit(0);
