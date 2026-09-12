import * as NodeFS from "node:fs";
import { assertLocalStack } from "./config.mjs";
const dir = process.argv[2],
  threadId = process.argv[3];
const cfg = JSON.parse(NodeFS.readFileSync(dir + "/private.json"));
assertLocalStack(cfg);
const terminalId = "readiness-terminal";
async function request(operation) {
  const r = await fetch(`http://127.0.0.1:${cfg.controller.PORT}/hosted/t3/terminal`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.controller.COMPADRE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operation, input: { threadId, terminalId, cols: 100, rows: 30 } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(operation + " " + r.status);
  const result = (await r.text()).trim().split("\n").map(JSON.parse);
  if (result.some((x) => x.error)) throw new Error("Terminal request failed");
  return result.at(-1)?.value;
}
await request("open");
async function prove(stage, expectedHistory) {
  const grant = await request("connection");
  if (!grant) throw new Error("Direct connection unsupported");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.url);
    let sent = 0,
      history = "",
      started = 0;
    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error("Terminal output timeout"));
    }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "connect", ticket: grant.ticket }));
    ws.onerror = () => {
      clearTimeout(deadline);
      reject(new Error("Terminal socket failed"));
    };
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type !== "event") return;
      ws.send(JSON.stringify({ type: "ack", sequence: frame.sequence }));
      const event = frame.event;
      if (event.type === "snapshot") {
        history = event.snapshot.history;
        if (expectedHistory && !history.includes(expectedHistory)) {
          clearTimeout(deadline);
          ws.close();
          reject(new Error("Replay lost output"));
          return;
        }
        started = performance.now();
        ws.send(
          JSON.stringify({
            type: "write",
            id: ++sent,
            data: `printf 'RECONNECT_%s\\n' '${stage}_6198'\r`,
          }),
        );
      } else if (event.type === "output") {
        history += event.data;
        if (history.includes("RECONNECT_" + stage + "_6198")) {
          clearTimeout(deadline);
          ws.close();
          resolve({
            stage,
            outputMs: Math.round(performance.now() - started),
            replayVerified: !!expectedHistory,
          });
        }
      }
    };
  });
}
console.log(await prove("FIRST"));
console.log(await prove("SECOND", "RECONNECT_FIRST_6198"));
