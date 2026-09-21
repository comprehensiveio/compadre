import assert from "node:assert/strict";
import test from "node:test";
import type { T3Message, T3ThreadSnapshot, T3TurnDispatch } from "../t3/client.js";
import {
  PROGRESS_FORCED_CHECKIN_MS,
  PROGRESS_QUIET_WINDOW_MS,
  SlackProgressReporter,
  buildSlackProgressState,
  createJevSlackProgressJudge,
  decideSlackProgress,
  previousFinalAnswer,
  progressCandidates,
  type SlackProgressJudgement,
  type SlackProgressState,
} from "./slack-progress-updates.js";

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

const dispatch: T3TurnDispatch = {
  sequence: 10,
  commandId: "command-1",
  messageId: "user-2",
  threadId: "thread-1",
  createdAt: at(0),
};

function message(
  id: string,
  role: T3Message["role"],
  text: string,
  seconds: number,
  overrides: Partial<T3Message> = {},
): T3Message {
  return {
    id,
    role,
    text,
    turnId: "turn-2",
    streaming: false,
    createdAt: at(seconds),
    updatedAt: at(seconds),
    ...overrides,
  };
}

function snapshot(input: {
  messages: T3Message[];
  toolStartsAt?: number[];
  state?: "running" | "completed";
}): T3ThreadSnapshot {
  return {
    snapshotSequence: 11,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Slack request",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      latestTurn: {
        turnId: "turn-2",
        state: input.state ?? "running",
        requestedAt: at(0),
        startedAt: at(1),
        completedAt: null,
        assistantMessageId: null,
      },
      messages: [
        message("user-1", "user", "fix the flaky login test", -3_600, { turnId: "turn-1" }),
        message("assistant-old", "assistant", "Fixed the race. Opened PR #412.", -3_500, {
          turnId: "turn-1",
        }),
        message("user-2", "user", "also bump the timeout to 30s", 0),
        ...input.messages,
      ],
      activities: (input.toolStartsAt ?? []).map((seconds, index) => ({
        id: `tool-${index}`,
        kind: "tool.started",
        turnId: "turn-2",
        createdAt: at(seconds),
      })),
      session: { status: "running", activeTurnId: "turn-2", lastError: null },
    },
  };
}

function judgement(overrides: Partial<SlackProgressJudgement> = {}): SlackProgressJudgement {
  return {
    addsNewInformation: 0.9,
    highLevelUpdate: 0.9,
    needsUserInput: 0.05,
    kind: "progress_milestone",
    kindConfidence: 0.8,
    worth: 2.3,
    model: "jev-test",
    ...overrides,
  };
}

const settled = { turnAgeMs: 10 * 60_000, sinceLastPostMs: null };

test("only finished intermediate messages followed by more work are candidates", () => {
  const first = message("a1", "assistant", "Looking at the test harness.", 10);
  const second = message("a2", "assistant", "Found the race; patching.", 60);
  const streaming = message("a3", "assistant", "Now I", 90, { streaming: true });
  assert.deepEqual(
    progressCandidates(snapshot({ messages: [first, second, streaming], toolStartsAt: [20] }), dispatch).map(
      (candidate) => candidate.id,
    ),
    ["a1", "a2"],
    "the last finished message counts once another message follows it",
  );
  assert.deepEqual(
    progressCandidates(snapshot({ messages: [first], toolStartsAt: [] }), dispatch),
    [],
    "a lone finished message may be the final answer",
  );
  assert.deepEqual(
    progressCandidates(snapshot({ messages: [first], toolStartsAt: [20] }), dispatch).map((c) => c.id),
    ["a1"],
    "a tool start after the message proves the turn continued",
  );
  assert.deepEqual(
    progressCandidates(snapshot({ messages: [first, second], state: "completed" }), dispatch),
    [],
    "completed turns belong to the outbox",
  );
});

test("the previous turn's final answer is recovered from the thread", () => {
  assert.equal(previousFinalAnswer(snapshot({ messages: [] }), dispatch)?.id, "assistant-old");
});

test("time sets the bar: quiet window, then milestones, then check-ins", () => {
  assert.deepEqual(decideSlackProgress(judgement(), settled), { post: true, reason: "milestone" });
  assert.deepEqual(
    decideSlackProgress(judgement(), { turnAgeMs: PROGRESS_QUIET_WINDOW_MS - 1, sinceLastPostMs: null }),
    { post: false, reason: "quiet_window" },
    "even a confident milestone waits out the quiet window",
  );
  assert.deepEqual(
    decideSlackProgress(judgement(), { turnAgeMs: 20 * 60_000, sinceLastPostMs: 60_000 }),
    { post: false, reason: "quiet_window" },
    "the window restarts after each post",
  );
  assert.equal(decideSlackProgress(judgement({ addsNewInformation: 0.3 }), settled).reason, "repeats_shown");
  assert.equal(
    decideSlackProgress(judgement({ highLevelUpdate: 0.2 }), settled).reason,
    "too_specific",
    "implementation detail stays in the web UI even when new and a milestone",
  );
  assert.equal(
    decideSlackProgress(judgement({ kind: "narration", kindConfidence: 0.7 }), settled).reason,
    "narration",
  );
  assert.equal(
    decideSlackProgress(judgement({ kind: "wrap_up", kindConfidence: 0.65, worth: 2.5 }), settled).reason,
    "wrap_up",
  );
  assert.equal(
    decideSlackProgress(judgement({ kindConfidence: 0.54, worth: 1.7 }), settled).reason,
    "low_value",
    "an uncertain milestone classification does not post (production run 1)",
  );
  assert.equal(decideSlackProgress(judgement({ worth: 1.2 }), settled).reason, "low_value");
  assert.deepEqual(
    decideSlackProgress(judgement({ worth: 1.2 }), { turnAgeMs: PROGRESS_FORCED_CHECKIN_MS, sinceLastPostMs: null }),
    { post: true, reason: "check_in" },
  );
  assert.equal(
    decideSlackProgress(judgement({ highLevelUpdate: 0.2, worth: 1.2 }), { turnAgeMs: PROGRESS_FORCED_CHECKIN_MS, sinceLastPostMs: null }).reason,
    "too_specific",
    "a check-in must be high level too",
  );
});

test("decisions post only when the user might redirect them", () => {
  assert.deepEqual(
    decideSlackProgress(judgement({ kind: "decision_point", kindConfidence: 0.9, needsUserInput: 0.35, worth: 1.3 }), settled),
    { post: true, reason: "decision" },
  );
  assert.equal(
    decideSlackProgress(judgement({ kind: "decision_point", kindConfidence: 0.85, needsUserInput: 0.1, worth: 1.8 }), settled).reason,
    "foregone_decision",
    "which table to migrate, constrained by the request (production run 2)",
  );
  assert.equal(
    decideSlackProgress(judgement({ kind: "decision_point", kindConfidence: 0.5, needsUserInput: 0.5 }), settled).reason,
    "low_value",
  );
});

test("questions and user-blocking blockers bypass every window; solved blockers do not", () => {
  const early = { turnAgeMs: 5_000, sinceLastPostMs: 1_000 };
  assert.deepEqual(decideSlackProgress(judgement({ needsUserInput: 0.95, addsNewInformation: 0.1 }), early), {
    post: true,
    reason: "needs_user",
  });
  assert.deepEqual(
    decideSlackProgress(judgement({ kind: "question_for_user", kindConfidence: 0.6, needsUserInput: 0.4 }), early),
    { post: true, reason: "needs_user" },
  );
  assert.deepEqual(
    decideSlackProgress(judgement({ kind: "blocked", kindConfidence: 0.9, needsUserInput: 0.6, highLevelUpdate: 0.1 }), early),
    { post: true, reason: "needs_user" },
    "a specific blocker that needs the user still posts at once",
  );
  assert.equal(
    decideSlackProgress(judgement({ kind: "blocked", kindConfidence: 0.96, needsUserInput: 0.14, highLevelUpdate: 0.28, worth: 2.6 }), settled).reason,
    "too_specific",
    "a self-resolved workaround follows the normal rules (production run 2)",
  );
});

test("the judged state carries what Slack has shown, timings, and the request", () => {
  const state = buildSlackProgressState({
    candidate: message("a2", "assistant", "Found the race; patching.", 300),
    userRequest: "also bump the timeout to 30s",
    shown: [{ postedAt: T0 + 120_000, text: "Looking at the test harness." }],
    previousFinal: message("assistant-old", "assistant", "Fixed the race. Opened PR #412.", -3_500),
    turnStartedAt: T0,
    lastPostAt: T0 + 120_000,
    toolCallsSinceLastPost: 7,
    now: T0 + 300_000,
  });
  assert.deepEqual(state, {
    agent_name: "Compadre",
    agent_still_working: true,
    user_request: "also bump the timeout to 30s",
    candidate: {
      text: "Found the race; patching.",
      seconds_since_turn_started: 300,
      seconds_since_last_slack_post: 180,
      tool_calls_since_last_slack_post: 7,
    },
    shown_in_slack_this_turn: [{ minutes_ago: 3, text: "Looking at the test harness." }],
    previous_final_answer: { minutes_ago: 63, text: "Fixed the race. Opened PR #412." },
  } satisfies SlackProgressState);
});

test("the reporter judges each candidate once and posts each milestone to one progress line", async () => {
  let clock = T0 + PROGRESS_QUIET_WINDOW_MS + 30_000;
  const judged: string[] = [];
  const posted: string[] = [];
  const links: Array<string | undefined> = [];
  const reporter = new SlackProgressReporter({
    judge: async (state) => {
      judged.push(state.candidate.text);
      return judgement();
    },
    slack: {
      async postProgressMessage(text, sessionLink) {
        posted.push(text);
        links.push(sessionLink?.url);
      },
    },
    userRequest: "also bump the timeout to 30s",
    context: {},
    now: () => clock,
  });
  const first = message("a1", "assistant", "Found the race; patching.", 30);
  const second = message("a2", "assistant", "Patched; running the suite.", 200);

  await reporter.observe(snapshot({ messages: [first], toolStartsAt: [40] }));
  assert.equal(posted.length, 0, "no dispatch attached yet");

  reporter.attachDispatch(dispatch, "https://compadre.example/thread/1");
  await reporter.observe(snapshot({ messages: [first], toolStartsAt: [40] }));
  await reporter.observe(snapshot({ messages: [first], toolStartsAt: [40, 50] }));
  assert.deepEqual(judged, ["Found the race; patching."], "a candidate is judged once");
  assert.deepEqual(posted, ["Found the race; patching."], "agent text is relayed verbatim");
  assert.deepEqual(links, ["https://compadre.example/thread/1"], "the session link rides along");

  clock += PROGRESS_QUIET_WINDOW_MS + 60_000;
  await reporter.observe(snapshot({ messages: [first, second], toolStartsAt: [40, 50, 210] }));
  assert.equal(judged.length, 2);
  assert.deepEqual(posted.at(-1), "Patched; running the suite.");
  assert.equal(posted.length, 2, "a second milestone updates the same line");
});

test("the reporter goes quiet once a browser message takes over the turn", async () => {
  const posted: string[] = [];
  const reporter = new SlackProgressReporter({
    judge: async () => judgement(),
    slack: {
      async postProgressMessage(text) {
        posted.push(text);
      },
    },
    userRequest: "also bump the timeout to 30s",
    context: {},
    now: () => T0 + 10 * 60_000,
  });
  reporter.attachDispatch(dispatch);
  const web = message("user-web", "user", "never mind, I'll take it from here", 20, {
    attribution: { origin: "web" },
  } as Partial<T3Message>);
  const candidate = message("a1", "assistant", "Found the race; patching.", 30);
  await reporter.observe(snapshot({ messages: [web, candidate], toolStartsAt: [40] }));
  assert.equal(posted.length, 0);
});

test("judge and Slack failures hold the update instead of throwing", async () => {
  const reporter = new SlackProgressReporter({
    judge: async () => {
      throw new Error("typesafe unavailable");
    },
    slack: {
      async postProgressMessage() {
        throw new Error("slack down");
      },
    },
    userRequest: "x",
    context: {},
    now: () => T0 + 10 * 60_000,
  });
  reporter.attachDispatch(dispatch);
  await reporter.observe(
    snapshot({ messages: [message("a1", "assistant", "Found it.", 30)], toolStartsAt: [40] }),
  );
});

test("the Jev judge maps all four answers from one request", async () => {
  let keys: string[] = [];
  const judge = createJevSlackProgressJudge({
    systemOne(request) {
      keys = Object.keys(request.questions).sort();
      return Promise.resolve({
        model: "jev-1.13.0",
        answers: {
          adds_new_information: { type: "noul", noul: 0.91 },
          high_level_update: { type: "noul", noul: 0.8 },
          needs_user_input: { type: "noul", noul: 0.04 },
          kind: {
            type: "choice",
            choice: "progress_milestone",
            confidence: 0.77,
            probabilities: {},
          },
          worth_interrupting_for: { type: "score", score: 2.2, confidence: 0.6, legend: {}, probabilities: {} },
        },
        usage: { input_tokens: 500, output_tokens: 40 },
      }) as never;
    },
  });
  const result = await judge(
    buildSlackProgressState({
      candidate: message("a1", "assistant", "Found it.", 30),
      userRequest: "x",
      shown: [],
      previousFinal: undefined,
      turnStartedAt: T0,
      lastPostAt: null,
      toolCallsSinceLastPost: 0,
      now: T0 + 60_000,
    }),
  );
  assert.deepEqual(keys, ["adds_new_information", "high_level_update", "kind", "needs_user_input", "worth_interrupting_for"]);
  assert.equal(result.highLevelUpdate, 0.8);
  assert.equal(result.kind, "progress_milestone");
  assert.equal(result.kindConfidence, 0.77);
  assert.equal(result.worth, 2.2);
  assert.equal(result.usage?.input_tokens, 500);
});
