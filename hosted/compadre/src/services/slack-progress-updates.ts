import type { TypeSafeClient, Usage } from "@typesafe-ai/sdk";
import { log, serializeError } from "../logging.js";
import type {
  T3Message,
  T3ThreadSnapshot,
  T3TurnDispatch,
} from "../t3/client.js";
import type { SlackSessionLink } from "./slack-markdown.js";
import {
  assistantMessagesForDispatch,
  hasLaterWebMessageForDispatch,
  t3SlackSessionLink,
} from "./t3-slack-conversation.js";
import { configuredTypeSafeClient } from "./typesafe-client.js";

/**
 * Mid-turn Slack progress updates (experiment).
 *
 * "jev": while a Slack-originated turn runs, each finished intermediate
 *   assistant message is judged by TypeSafe's Jev model against what the user
 *   has already seen in Slack this turn. Worthwhile milestones, blockers, and
 *   questions are posted to one evolving progress message in the thread; the
 *   final answer is still delivered only by the outbox.
 * "off": nothing is posted before the final answer, the previous behavior.
 *
 * Code-level kill switch. Inert without TYPESAFE_API_KEY.
 */
export const SLACK_PROGRESS_UPDATES: "jev" | "off" = "jev";

/**
 * Time raises or lowers the bar; it never blocks something the user must
 * see. The point of progress updates is feedback on long runs, and in the
 * first two production runs nothing in the opening minutes was worth a
 * notification. Measured from the turn start or the last Slack post:
 *
 *   < QUIET_WINDOW      only a question, or a blocker that needs the user
 *   < FORCED_CHECKIN    a confident, high-level milestone or a decision the
 *                       user might redirect
 *   >= FORCED_CHECKIN   also a minor high-level update (check-in)
 *
 * There is no minimum interval between posts: updates edit one message in
 * place, so two real milestones close together cost nothing.
 */
export const PROGRESS_QUIET_WINDOW_MS = 5 * 60_000;
export const PROGRESS_FORCED_CHECKIN_MS = 15 * 60_000;

/** Decision thresholds; calibrate with `npm run slack:progress-probe`. */
export const PROGRESS_NEEDS_USER_THRESHOLD = 0.8;
export const PROGRESS_NEW_INFORMATION_THRESHOLD = 0.6;
export const PROGRESS_MILESTONE_SCORE = 1.5;
/**
 * A milestone posts only when Jev is confident it IS a milestone. In the
 * first production run the one premature post was a message Jev classified
 * as a milestone at 0.54 confidence (worth 1.70); the genuine one scored
 * 0.99 (worth 1.83). Worth alone did not separate them; confidence did.
 */
export const PROGRESS_MILESTONE_CONFIDENCE = 0.75;
export const PROGRESS_CHECKIN_SCORE = 1;
/**
 * A blocker bypasses every other rule only when the user is actually needed.
 * A workaround the agent already chose (production run 2: "no X display, so
 * I'm using the headless fallback") is a blocker Jev scored 0.96 with
 * needs-user 0.14; it must not interrupt anyone.
 */
export const PROGRESS_BLOCKER_NEEDS_USER = 0.5;
/**
 * A decision posts only when the user might plausibly redirect it. A choice
 * that was foregone by the request itself (production run 2: which table to
 * migrate, given "do a different one") is not worth a notification.
 */
export const PROGRESS_DECISION_REDIRECT = 0.3;
/**
 * Progress posts must read at task level. Implementation detail (file names,
 * commands, code-level findings) stays in the web UI even when it is new.
 */
export const PROGRESS_HIGH_LEVEL_THRESHOLD = 0.7;

const MAX_SHOWN_MESSAGES = 10;
const MAX_TEXT_CHARS = 1_500;

export type SlackProgressState = {
  agent_name: "Compadre";
  agent_still_working: true;
  user_request: string;
  candidate: {
    text: string;
    seconds_since_turn_started: number;
    seconds_since_last_slack_post: number | null;
    tool_calls_since_last_slack_post: number;
  };
  shown_in_slack_this_turn: Array<{ minutes_ago: number; text: string }>;
  previous_final_answer: { minutes_ago: number; text: string } | null;
};

const PROGRESS_KINDS = {
  progress_milestone:
    "Reports something concrete that was found, decided, finished, or changed since the last update.",
  decision_point:
    "Reports a choice the agent made between real alternatives, or a change of direction, that shapes the rest of the work.",
  plan_or_intent:
    "Announces what the agent is about to do next without reporting a result yet; no alternatives weighed, nothing finished.",
  narration:
    "Running commentary about routine steps (reading files, running a command) with no result the user needs.",
  question_for_user:
    "Asks the user something or needs their decision before continuing.",
  blocked:
    "Reports that the agent cannot proceed: missing access, a failing environment, or a serious unexpected problem.",
  wrap_up:
    "Summarizes the completed work as if answering the request; reads like a final answer.",
} as const;

const PROGRESS_QUESTIONS = {
  adds_new_information: {
    type: "noul",
    instructions:
      "Does `candidate.text` tell the user something they have not already been told in `shown_in_slack_this_turn` or `previous_final_answer`? Rephrasing the same plan, restating the request, or repeating an earlier finding is not new.",
  },
  high_level_update: {
    type: "noul",
    instructions:
      "Is `candidate.text` a high-level update about the overall task in `user_request`: a stage completed, a decision made or needed, or a change of direction, written so someone skimming Slack without the codebase open would follow it?",
    criteria: {
      true:
        "Describes progress or a decision at the level of the task or its major parts, e.g. 'the fix is in and the suite passes, now checking the two tests that depended on the old value'.",
      false:
        "Implementation detail or narrow findings: specific files, functions, commands, config keys, line numbers, individual test names, or step-by-step mechanics of how something is being done.",
    },
  },
  needs_user_input: {
    type: "noul",
    instructions:
      "Does `candidate.text` ask the user a question or need a decision, permission, or information from them before the agent named in `agent_name` can continue?",
  },
  kind: {
    type: "choice",
    instructions:
      "What kind of message is `candidate.text`, written by the agent named in `agent_name` while working on `user_request`?",
    criteria: PROGRESS_KINDS,
  },
  worth_interrupting_for: {
    type: "score",
    instructions:
      "How much would a user waiting in Slack, who has seen `shown_in_slack_this_turn`, want to be told `candidate.text` right now, given `candidate.seconds_since_turn_started` and `candidate.seconds_since_last_slack_post`?",
    criteria: [
      "Nothing a waiting user needs: routine narration or a restatement of what they already know.",
      "Minor detail; fine to mention only if the user has heard nothing for a long while.",
      "A meaningful milestone, finding, or change of direction the user would want to know about.",
      "Urgent: the user must know now because the agent is blocked, needs a decision, or found a serious problem.",
    ],
  },
} as const;

export type SlackProgressKind = keyof typeof PROGRESS_KINDS;

export interface SlackProgressJudgement {
  addsNewInformation: number;
  highLevelUpdate: number;
  needsUserInput: number;
  kind: SlackProgressKind;
  kindConfidence: number;
  worth: number;
  model: string;
  usage?: Usage;
}

export type SlackProgressJudge = (
  state: SlackProgressState,
) => Promise<SlackProgressJudgement>;

export type SlackProgressDecision =
  | { post: true; reason: "needs_user" | "milestone" | "decision" | "check_in" }
  | {
      post: false;
      reason:
        | "quiet_window"
        | "repeats_shown"
        | "foregone_decision"
        | "too_specific"
        | "narration"
        | "wrap_up"
        | "low_value"
        | "judge_failed";
    };

export function configuredSlackProgressJudge(
  environment: NodeJS.ProcessEnv = process.env,
): SlackProgressJudge | null {
  if (SLACK_PROGRESS_UPDATES !== "jev") return null;
  const client = configuredTypeSafeClient(environment);
  return client ? createJevSlackProgressJudge(client) : null;
}

export function createJevSlackProgressJudge(
  client: Pick<TypeSafeClient, "systemOne">,
): SlackProgressJudge {
  return async (state) => {
    const result = await client.systemOne({
      state,
      questions: PROGRESS_QUESTIONS,
    });
    return {
      addsNewInformation: result.answers.adds_new_information.noul,
      highLevelUpdate: result.answers.high_level_update.noul,
      needsUserInput: result.answers.needs_user_input.noul,
      kind: result.answers.kind.choice,
      kindConfidence: result.answers.kind.confidence,
      worth: result.answers.worth_interrupting_for.score,
      model: result.model,
      usage: result.usage,
    };
  };
}

export interface SlackProgressTiming {
  turnAgeMs: number;
  sinceLastPostMs: number | null;
}

/** Turn raw judgements plus elapsed time into a post-or-hold decision. */
export function decideSlackProgress(
  judgement: SlackProgressJudgement,
  timing: SlackProgressTiming,
): SlackProgressDecision {
  const confidentKind = judgement.kindConfidence >= PROGRESS_MILESTONE_CONFIDENCE;
  const asksUser =
    judgement.needsUserInput >= PROGRESS_NEEDS_USER_THRESHOLD ||
    (judgement.kind === "question_for_user" && judgement.kindConfidence >= 0.5) ||
    (judgement.kind === "blocked" &&
      judgement.kindConfidence >= 0.5 &&
      judgement.needsUserInput >= PROGRESS_BLOCKER_NEEDS_USER);
  if (asksUser) return { post: true, reason: "needs_user" };

  const silenceMs = timing.sinceLastPostMs ?? timing.turnAgeMs;
  if (silenceMs < PROGRESS_QUIET_WINDOW_MS) {
    return { post: false, reason: "quiet_window" };
  }
  if (judgement.addsNewInformation < PROGRESS_NEW_INFORMATION_THRESHOLD) {
    return { post: false, reason: "repeats_shown" };
  }
  if (judgement.highLevelUpdate < PROGRESS_HIGH_LEVEL_THRESHOLD) {
    return { post: false, reason: "too_specific" };
  }
  if (judgement.kind === "narration" && judgement.kindConfidence >= 0.5) {
    return { post: false, reason: "narration" };
  }
  // A summary that reads like the answer is about to be delivered by the
  // outbox as the final message; posting it early would duplicate it.
  if (judgement.kind === "wrap_up" && judgement.kindConfidence >= 0.5) {
    return { post: false, reason: "wrap_up" };
  }
  if (judgement.kind === "decision_point" && confidentKind) {
    return judgement.needsUserInput >= PROGRESS_DECISION_REDIRECT
      ? { post: true, reason: "decision" }
      : { post: false, reason: "foregone_decision" };
  }
  if (
    judgement.kind === "progress_milestone" &&
    confidentKind &&
    judgement.worth >= PROGRESS_MILESTONE_SCORE
  ) {
    return { post: true, reason: "milestone" };
  }
  if (
    silenceMs >= PROGRESS_FORCED_CHECKIN_MS &&
    judgement.worth >= PROGRESS_CHECKIN_SCORE
  ) {
    return { post: true, reason: "check_in" };
  }
  return { post: false, reason: "low_value" };
}

function clip(text: string): string {
  const normalized = text.trim();
  return normalized.length > MAX_TEXT_CHARS
    ? `${normalized.slice(0, MAX_TEXT_CHARS)}…`
    : normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `tool.started` activity timestamps that belong to the dispatched turn. */
export function toolStartTimesForDispatch(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): number[] {
  const requestedTurnId = snapshot.thread.messages.find(
    (message) => message.id === dispatch.messageId,
  )?.turnId;
  const dispatchedAt = Date.parse(dispatch.createdAt);
  const rawActivities = snapshot.thread.activities;
  if (!Array.isArray(rawActivities)) return [];
  const times: number[] = [];
  for (const raw of rawActivities) {
    const activity = record(raw);
    if (!activity || activity.kind !== "tool.started") continue;
    const createdAt =
      typeof activity.createdAt === "string"
        ? Date.parse(activity.createdAt)
        : Number.NaN;
    if (!Number.isFinite(createdAt)) continue;
    const turnId =
      typeof activity.turnId === "string" ? activity.turnId : undefined;
    const belongs = requestedTurnId
      ? turnId === requestedTurnId || (turnId === undefined && createdAt >= dispatchedAt)
      : createdAt >= dispatchedAt;
    if (belongs) times.push(createdAt);
  }
  return times;
}

/**
 * Finished intermediate assistant messages of the running turn: text that
 * stopped streaming and was followed by more work (a later message or a
 * tool start). The last message of a completed turn is never a candidate;
 * the outbox owns that.
 */
export function progressCandidates(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): T3Message[] {
  if (snapshot.thread.latestTurn?.state !== "running") return [];
  const messages = assistantMessagesForDispatch(snapshot, dispatch);
  const toolStarts = toolStartTimesForDispatch(snapshot, dispatch);
  return messages.filter((message, index) => {
    if (message.streaming || !message.text.trim()) return false;
    if (index < messages.length - 1) return true;
    const startedAt = Date.parse(message.createdAt);
    return toolStarts.some((toolAt) => toolAt > startedAt);
  });
}

/** The previous turn's last assistant message, if the thread had one. */
export function previousFinalAnswer(
  snapshot: T3ThreadSnapshot,
  dispatch: T3TurnDispatch,
): T3Message | undefined {
  const requestedIndex = snapshot.thread.messages.findIndex(
    (message) => message.id === dispatch.messageId && message.role === "user",
  );
  if (requestedIndex < 0) return undefined;
  return [...snapshot.thread.messages.slice(0, requestedIndex)]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && !message.streaming && message.text.trim(),
    );
}

export function buildSlackProgressState(input: {
  candidate: T3Message;
  userRequest: string;
  shown: ReadonlyArray<{ postedAt: number; text: string }>;
  previousFinal: T3Message | undefined;
  turnStartedAt: number;
  lastPostAt: number | null;
  toolCallsSinceLastPost: number;
  now: number;
}): SlackProgressState {
  const minutesAgo = (at: number) => Math.max(0, Math.round((input.now - at) / 60_000));
  return {
    agent_name: "Compadre",
    agent_still_working: true,
    user_request: clip(input.userRequest),
    candidate: {
      text: clip(input.candidate.text),
      seconds_since_turn_started: Math.max(
        0,
        Math.round((input.now - input.turnStartedAt) / 1_000),
      ),
      seconds_since_last_slack_post:
        input.lastPostAt === null
          ? null
          : Math.max(0, Math.round((input.now - input.lastPostAt) / 1_000)),
      tool_calls_since_last_slack_post: input.toolCallsSinceLastPost,
    },
    shown_in_slack_this_turn: input.shown
      .slice(-MAX_SHOWN_MESSAGES)
      .map((entry) => ({ minutes_ago: minutesAgo(entry.postedAt), text: clip(entry.text) })),
    previous_final_answer: input.previousFinal
      ? {
          minutes_ago: minutesAgo(Date.parse(input.previousFinal.updatedAt)),
          text: clip(input.previousFinal.text),
        }
      : null,
  };
}

/**
 * The agent's intermediate text is relayed verbatim, never decorated; the
 * message is distinguished only by the session-link footer it shares with the
 * final answer and its position above it.
 */
export interface SlackProgressSink {
  postProgressMessage(
    markdownText: string,
    sessionLink?: SlackSessionLink,
  ): Promise<void>;
}

/**
 * Per-turn observer for the Slack-originated foreground watcher. Snapshots
 * arrive in order and are processed one at a time; every judgement is logged
 * and failures fail closed (nothing is posted). Once a browser message takes
 * over the turn, the reporter goes quiet so browser turns stay UI-only.
 */
export class SlackProgressReporter {
  private dispatch: T3TurnDispatch | undefined;
  private sessionLink: SlackSessionLink | undefined;
  private readonly judged = new Set<string>();
  private readonly shown: Array<{ postedAt: number; text: string }> = [];
  private lastPostAt: number | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      judge: SlackProgressJudge;
      slack: SlackProgressSink;
      userRequest: string;
      context: Record<string, unknown>;
      now?: () => number;
    },
  ) {}

  attachDispatch(dispatch: T3TurnDispatch, detailsUrl?: string | null): void {
    this.dispatch = dispatch;
    this.sessionLink = detailsUrl ? t3SlackSessionLink(detailsUrl) : undefined;
  }

  /** Serialized so a slow judgement never interleaves with the next snapshot. */
  observe(snapshot: T3ThreadSnapshot): Promise<void> {
    this.queue = this.queue.then(() => this.process(snapshot)).catch(() => undefined);
    return this.queue;
  }

  private async process(snapshot: T3ThreadSnapshot): Promise<void> {
    const dispatch = this.dispatch;
    if (!dispatch || this.stopped) return;
    if (hasLaterWebMessageForDispatch(snapshot, dispatch)) {
      this.stopped = true;
      log.info(this.input.context, "slack progress updates stopped; browser took over the turn");
      return;
    }
    const now = this.input.now ?? Date.now;
    const turnStartedAt = Date.parse(dispatch.createdAt);
    const previousFinal = previousFinalAnswer(snapshot, dispatch);
    for (const candidate of progressCandidates(snapshot, dispatch)) {
      if (this.judged.has(candidate.id)) continue;
      this.judged.add(candidate.id);
      const at = now();
      const toolCallsSinceLastPost = toolStartTimesForDispatch(snapshot, dispatch).filter(
        (toolAt) => toolAt > (this.lastPostAt ?? turnStartedAt),
      ).length;
      const state = buildSlackProgressState({
        candidate,
        userRequest: this.input.userRequest,
        shown: this.shown,
        previousFinal,
        turnStartedAt,
        lastPostAt: this.lastPostAt,
        toolCallsSinceLastPost,
        now: at,
      });
      const timing: SlackProgressTiming = {
        turnAgeMs: at - turnStartedAt,
        sinceLastPostMs: this.lastPostAt === null ? null : at - this.lastPostAt,
      };
      let judgement: SlackProgressJudgement;
      let decision: SlackProgressDecision;
      try {
        judgement = await this.input.judge(state);
        decision = decideSlackProgress(judgement, timing);
      } catch (error) {
        log.warn(
          { ...this.input.context, assistantMessageId: candidate.id, ...serializeError(error) },
          "slack progress judgement failed; holding update",
        );
        continue;
      }
      log.info(
        {
          ...this.input.context,
          assistantMessageId: candidate.id,
          post: decision.post,
          reason: decision.reason,
          addsNewInformation: judgement.addsNewInformation,
          highLevelUpdate: judgement.highLevelUpdate,
          needsUserInput: judgement.needsUserInput,
          kind: judgement.kind,
          kindConfidence: judgement.kindConfidence,
          worth: judgement.worth,
          turnAgeMs: timing.turnAgeMs,
          sinceLastPostMs: timing.sinceLastPostMs,
          shownCount: this.shown.length,
          model: judgement.model,
          inputTokens: judgement.usage?.input_tokens,
          elapsedMs: now() - at,
        },
        "slack progress update judged",
      );
      if (!decision.post) continue;
      try {
        await this.input.slack.postProgressMessage(
          candidate.text.trim(),
          this.sessionLink,
        );
        this.lastPostAt = now();
        this.shown.push({ postedAt: this.lastPostAt, text: candidate.text.trim() });
      } catch (error) {
        log.warn(
          { ...this.input.context, assistantMessageId: candidate.id, ...serializeError(error) },
          "slack progress update post failed",
        );
      }
    }
  }
}
