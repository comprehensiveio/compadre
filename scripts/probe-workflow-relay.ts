interface ProbeEvent {
  id: string;
  type: string;
  atMs: number;
  deltaLength?: number;
}

const relayUrl = process.env.COMPADRE_WORKFLOW_RELAY_URL?.replace(/\/$/, "");
const apiKey = process.env.COMPADRE_API_KEY;
if (!relayUrl || !apiKey) {
  throw new Error(
    "COMPADRE_WORKFLOW_RELAY_URL and COMPADRE_API_KEY are required",
  );
}

const authorization = { Authorization: `Bearer ${apiKey}` };
const startedAt = Date.now();

function report(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

async function readEvents(
  url: string,
  headers: Record<string, string> = {},
): Promise<ProbeEvent[]> {
  const response = await fetch(url, {
    headers: { ...authorization, ...headers },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Event stream returned ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ProbeEvent[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      let id = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!id || !data) continue;
      const chunk = JSON.parse(data) as { type?: string; delta?: unknown };
      const event: ProbeEvent = {
        id,
        type: chunk.type ?? "unknown",
        atMs: Date.now() - startedAt,
        ...(typeof chunk.delta === "string"
          ? { deltaLength: chunk.delta.length }
          : {}),
      };
      events.push(event);
      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
        await reader.cancel();
        return events;
      }
    }
    if (done) return events;
  }
}

const healthStarted = Date.now();
const health = await fetch(`${relayUrl}/health`);
report({
  phase: "health",
  status: health.status,
  elapsedMs: Date.now() - healthStarted,
});
if (!health.ok) throw new Error(`Relay health check returned ${health.status}`);

const prompt =
  process.argv.slice(2).join(" ") || "Reply with exactly: relay works";
const launchStarted = Date.now();
const response = await fetch(`${relayUrl}/workflow-runs`, {
  method: "POST",
  headers: { ...authorization, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, maxTurns: 3 }),
});
const launch = (await response.json()) as {
  runId?: string;
  taskRunId?: string;
  eventsUrl?: string;
};
report({
  phase: "launch",
  status: response.status,
  elapsedMs: Date.now() - launchStarted,
  runId: launch.runId,
  taskRunId: launch.taskRunId,
});
if (!response.ok || !launch.runId || !launch.eventsUrl) {
  throw new Error(`Workflow launch returned ${response.status}`);
}

const events = await readEvents(new URL(launch.eventsUrl, relayUrl).toString());
for (const event of events) report({ phase: "event", ...event });
if (events.at(-1)?.type !== "RUN_FINISHED") {
  throw new Error(`Run ended with ${events.at(-1)?.type ?? "no terminal event"}`);
}

const checkpoint = events[Math.min(1, events.length - 1)]?.id;
if (!checkpoint) throw new Error("Run emitted no durable checkpoint");
const replay = await readEvents(
  new URL(
    `/workflow-runs/${encodeURIComponent(launch.runId)}/events`,
    relayUrl,
  ).toString(),
  { "Last-Event-ID": checkpoint },
);
const checkpointRepeated = replay.some((event) => event.id === checkpoint);
report({
  phase: "reconnect",
  checkpoint,
  replayedEvents: replay.length,
  firstReplayId: replay[0]?.id,
  terminal: replay.at(-1)?.type,
  checkpointRepeated,
});
if (checkpointRepeated || replay.at(-1)?.type !== "RUN_FINISHED") {
  throw new Error("Resumed stream duplicated its checkpoint or missed completion");
}
