/**
 * Calibrate the mid-turn Slack progress gate against sample intermediate
 * messages.
 *
 *   TYPESAFE_API_KEY=... npm run slack:progress-probe
 *   npm run slack:progress-probe -- path/to/cases.json
 *
 * A cases file is an array of { label, expect: "post" | "hold", state, timing? }
 * where state matches SlackProgressState and timing is
 * { turnAgeMs, sinceLastPostMs }. Prints every Jev answer next to the code
 * decision so the constants in src/services/slack-progress-updates.ts can be
 * tuned on real transcripts.
 */
import fs from "node:fs";
import dotenv from "dotenv";
import {
  configuredSlackProgressJudge,
  decideSlackProgress,
  type SlackProgressState,
  type SlackProgressTiming,
} from "../src/services/slack-progress-updates.js";

dotenv.config({ path: ".env.local", quiet: true });

interface ProbeCase {
  label: string;
  expect: "post" | "hold";
  state: SlackProgressState;
  timing?: SlackProgressTiming;
}

const shown = [
  { minutes_ago: 9, text: "Looking into the flaky login test; reproducing it locally first." },
];
const previousFinal = {
  minutes_ago: 58,
  text: "Fixed the race between the cookie write and the redirect. Opened PR #412.",
};

function probe(
  label: string,
  expect: ProbeCase["expect"],
  text: string,
  options: {
    shown?: typeof shown;
    turnAgeS?: number;
    sinceLastS?: number | null;
    tools?: number;
    request?: string;
  } = {},
): ProbeCase {
  const turnAgeS = options.turnAgeS ?? 600;
  const sinceLastS = options.sinceLastS === undefined ? 540 : options.sinceLastS;
  return {
    label,
    expect,
    state: {
      agent_name: "Compadre",
      agent_still_working: true,
      user_request: options.request ?? "actually can you also bump the timeout to 30s",
      candidate: {
        text,
        seconds_since_turn_started: turnAgeS,
        seconds_since_last_slack_post: sinceLastS,
        tool_calls_since_last_slack_post: options.tools ?? 12,
      },
      shown_in_slack_this_turn: options.shown ?? shown,
      previous_final_answer: previousFinal,
    },
    timing: {
      turnAgeMs: turnAgeS * 1_000,
      sinceLastPostMs: sinceLastS === null ? null : sinceLastS * 1_000,
    },
  };
}

const builtInCases: ProbeCase[] = [
  probe(
    "milestone with finding",
    "post",
    "Found it: the 30s timeout is overridden per-test by a fixture that hardcodes 5s. Removing the override and bumping the shared default.",
  ),
  probe(
    "blocker",
    "post",
    "The e2e suite needs the STAGING_LOGIN_PASSWORD secret and it is not available in this environment, so I cannot verify the fix end to end.",
    { turnAgeS: 60, sinceLastS: null },
  ),
  probe(
    "question for user",
    "post",
    "Two tests rely on the 5s timeout to assert a timeout error. Should I keep those at 5s or update the assertions for 30s?",
    { turnAgeS: 60, sinceLastS: null },
  ),
  probe("narration", "hold", "Reading playwright.config.ts to find the timeout setting."),
  probe(
    "restated plan",
    "hold",
    "I'll reproduce the flaky login test locally first, then look at the timeout.",
  ),
  probe(
    "repeat of previous final",
    "hold",
    "The race between the cookie write and the redirect is fixed in PR #412.",
  ),
  probe(
    "early narration",
    "hold",
    "Starting by running the login test to see the failure.",
    { turnAgeS: 20, sinceLastS: null, tools: 1 },
  ),
  probe(
    "early real finding",
    "post",
    "The flake reproduces on the first run: the login redirect races the session cookie write.",
    { turnAgeS: 45, sinceLastS: null, tools: 3 },
  ),
  probe(
    "minor detail after long silence",
    "post",
    "Suite is running; 41 of 60 tests passed so far, no failures yet.",
    { turnAgeS: 1_500, sinceLastS: 1_200, tools: 40 },
  ),
  probe(
    "minor detail after short silence",
    "hold",
    "Suite is running; 41 of 60 tests passed so far, no failures yet.",
    { turnAgeS: 400, sinceLastS: 330, tools: 6 },
  ),
  probe(
    "wrap-up before final",
    "hold",
    "Done. Bumped the default timeout to 30s and removed the fixture override; all 60 tests pass. Opening the PR now.",
  ),
];

const casesPath = process.argv[2];
const cases: ProbeCase[] = casesPath
  ? (JSON.parse(fs.readFileSync(casesPath, "utf8")) as ProbeCase[])
  : builtInCases;

const judge = configuredSlackProgressJudge();
if (!judge) {
  console.error("TYPESAFE_API_KEY is required (or the gate constant is off).");
  process.exit(1);
}

let agreements = 0;
const rows = [];
for (const probeCase of cases) {
  const startedAt = Date.now();
  const judgement = await judge(probeCase.state);
  const timing = probeCase.timing ?? {
    turnAgeMs: probeCase.state.candidate.seconds_since_turn_started * 1_000,
    sinceLastPostMs:
      probeCase.state.candidate.seconds_since_last_slack_post === null
        ? null
        : probeCase.state.candidate.seconds_since_last_slack_post * 1_000,
  };
  const decision = decideSlackProgress(judgement, timing);
  const outcome = decision.post ? "post" : "hold";
  const agrees = outcome === probeCase.expect;
  if (agrees) agreements += 1;
  rows.push({
    label: probeCase.label,
    expect: probeCase.expect,
    decision: `${outcome}:${decision.reason}`,
    ok: agrees ? "✓" : "✗",
    new: judgement.addsNewInformation.toFixed(2),
    asks: judgement.needsUserInput.toFixed(2),
    kind: `${judgement.kind}@${judgement.kindConfidence.toFixed(2)}`,
    worth: judgement.worth.toFixed(2),
    ms: Date.now() - startedAt,
    tokens: judgement.usage?.input_tokens,
  });
}
console.table(rows);
console.log(`${agreements}/${cases.length} decisions matched expectations`);
