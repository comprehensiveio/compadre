/**
 * Calibrate the untagged Slack reply gate against sample threads.
 *
 *   TYPESAFE_API_KEY=... npm run slack:reply-gate-probe
 *   npm run slack:reply-gate-probe -- path/to/cases.json
 *
 * A cases file is an array of { label, expect: "respond" | "ignore", state }
 * where state matches SlackReplyGateState. Without a file the built-in cases
 * run. Prints both Jev probabilities and the code decision so thresholds in
 * src/services/slack-reply-gate.ts can be tuned on real thread samples.
 */
import fs from "node:fs";
import dotenv from "dotenv";
import {
  configuredSlackReplyJudge,
  decideSlackReply,
  type SlackReplyGateState,
} from "../src/services/slack-reply-gate.js";

dotenv.config({ path: ".env.local", quiet: true });

interface ProbeCase {
  label: string;
  expect: "respond" | "ignore";
  state: SlackReplyGateState;
}

const priorThread = [
  {
    author: "U1",
    from_agent: false,
    text: "<@UBOT> the login e2e test is flaky, can you fix it?",
  },
  {
    author: "Compadre",
    from_agent: true,
    text: "Fixed the race in the login test by awaiting the session cookie. Opened PR #412.",
  },
];

function probe(
  label: string,
  expect: ProbeCase["expect"],
  replyText: string,
  options: { author?: string; working?: boolean; thread?: typeof priorThread } = {},
): ProbeCase {
  return {
    label,
    expect,
    state: {
      agent_name: "Compadre",
      agent_is_working: options.working ?? false,
      thread: options.thread ?? priorThread,
      reply: {
        author: options.author ?? "U1",
        text: replyText,
        has_attachments: false,
      },
    },
  };
}

const builtInCases: ProbeCase[] = [
  probe("follow-up request", "respond", "actually can you also bump the timeout to 30s"),
  probe("named without tag", "respond", "compadre, also add a retry around the redirect"),
  probe("correction", "respond", "that's not right, the cookie is set in the middleware not the handler"),
  probe("steer while working", "respond", "wait, don't touch the middleware", { working: true }),
  probe("question to agent", "respond", "did you run the full suite or just that file?"),
  probe("thanks", "ignore", "thanks!"),
  probe("emoji ack", "ignore", ":+1:"),
  probe("human to human", "ignore", "<@U2> can you review #412 when you get a sec?", { author: "U1" }),
  probe("human reply to human", "ignore", "yep, looking now", { author: "U2" }),
  probe("status note", "ignore", "fyi merging this after standup"),
  probe("human discussion about agent", "ignore", "compadre's fix looks fine to me, I'll merge it", { author: "U2" }),
];

const casesPath = process.argv[2];
const cases: ProbeCase[] = casesPath
  ? (JSON.parse(fs.readFileSync(casesPath, "utf8")) as ProbeCase[])
  : builtInCases;

const judge = configuredSlackReplyJudge();
if (!judge) {
  console.error("TYPESAFE_API_KEY is required (or the gate constant is off).");
  process.exit(1);
}

let agreements = 0;
const rows = [];
for (const probeCase of cases) {
  const startedAt = Date.now();
  const judgement = await judge(probeCase.state);
  const decision = decideSlackReply(judgement);
  const agrees = decision.outcome === probeCase.expect;
  if (agrees) agreements += 1;
  rows.push({
    label: probeCase.label,
    expect: probeCase.expect,
    decision: decision.outcome,
    ok: agrees ? "✓" : "✗",
    wants: judgement.wantsAgentAction.toFixed(2),
    side: judgement.humanSideConversation.toFixed(2),
    ms: Date.now() - startedAt,
    tokens: judgement.usage?.input_tokens,
    model: judgement.model,
  });
}
console.table(rows);
console.log(`${agreements}/${cases.length} decisions matched expectations`);
