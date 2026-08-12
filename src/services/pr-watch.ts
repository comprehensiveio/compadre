import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { REPO_PATH } from "../config.js";
import { gitEnvironment } from "../repo.js";
import { SlackClient } from "./slack-client.js";

const REPOSITORY = "comprehensiveio/comp";
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const RENDER_SERVICE_CACHE_MS = 10 * 60 * 1000;
const STALE_DELIVERY_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15 * 1000;
const PATCH_SCAN_COMMIT_LIMIT = 500;
const RENDER_PROJECT_NAME = "CM";
const RENDER_ENVIRONMENT_NAME = "Prod";
const RENDER_SERVICE_NAME_PREFIX = "cm-app-";

export interface PullRequestWatchRequest {
  prNumber: number;
  prUrl: string;
}

export interface PullRequestWatchDestination {
  teamId: string;
  channelId: string;
  threadTs: string;
}

interface PullRequestDetails {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  base: { sha: string };
  head: { sha: string };
}

interface PullRequestCommit {
  sha: string;
}

interface WatchRow {
  id: string;
  pr_number: number;
  pr_url: string;
  slack_team_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  matched_prod_commit: string | null;
}

interface RenderDeploy {
  status?: string;
  commit?: { id?: string };
}

interface RenderDeployPageItem {
  cursor?: string;
  deploy?: RenderDeploy;
}

export interface RenderService {
  id?: string;
  name?: string;
  type?: string;
  repo?: string;
  branch?: string;
  suspended?: string;
}

interface RenderServicePageItem {
  cursor?: string;
  service?: RenderService;
}

interface RenderProjectPageItem {
  project?: { id?: string; name?: string };
}

interface RenderEnvironmentPageItem {
  environment?: { id?: string; name?: string; projectId?: string };
}

/** Legacy bootstrap retained while the Drizzle migration baseline rolls out. */
export const PR_WATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS compadre_pr_watches (
  id uuid PRIMARY KEY,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  pr_url text NOT NULL,
  slack_team_id text NOT NULL,
  slack_channel_id text NOT NULL,
  slack_thread_ts text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (
    status IN ('waiting', 'delivering', 'notified', 'closed_unmerged')
  ),
  matched_prod_commit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  delivery_started_at timestamptz,
  notified_at timestamptz,
  last_error text,
  UNIQUE (pr_number, slack_team_id, slack_channel_id, slack_thread_ts)
);

ALTER TABLE compadre_pr_watches
  ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz;

CREATE INDEX IF NOT EXISTS compadre_pr_watches_waiting_idx
  ON compadre_pr_watches (created_at)
  WHERE status = 'waiting';
`;

function sslForConnectionString(connectionString: string): pg.PoolConfig["ssl"] {
  try {
    return new URL(connectionString).hostname.endsWith(".render.com")
      ? { rejectUnauthorized: true }
      : undefined;
  } catch {
    return undefined;
  }
}

async function githubJson<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is required for PR watches");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "compadre-pr-watch",
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function githubPullRequestCommits(
  prNumber: number,
): Promise<PullRequestCommit[]> {
  const commits: PullRequestCommit[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson<PullRequestCommit[]>(
      `/repos/${REPOSITORY}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
    );
    commits.push(...batch);
    if (batch.length < 100) return commits;
  }
  throw new Error(`PR #${prNumber} has too many commits to track safely`);
}

async function git(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: REPO_PATH,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024 * 1024) {
        child.kill();
        reject(new Error(`git ${args[0]} output exceeded 64 MiB`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(input);
  });
}

async function fetchWatchRefs(prNumber: number): Promise<void> {
  const shallow = (await git(["rev-parse", "--is-shallow-repository"])) === "true";
  await git([
    "fetch",
    "--no-tags",
    ...(shallow ? ["--depth=1000"] : []),
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/heads/prod:refs/remotes/origin/prod",
    `+refs/pull/${prNumber}/head:refs/compadre-pr-watches/${prNumber}`,
  ]);
}

async function deleteWatchRef(prNumber: number): Promise<void> {
  await git(["update-ref", "-d", `refs/compadre-pr-watches/${prNumber}`]);
}

async function isAncestor(commit: string, descendant: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", commit, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function stablePatchId(patch: string): Promise<string | null> {
  if (!patch.trim()) return null;
  const output = await git(["patch-id", "--stable"], patch);
  return output.split(/\s+/)[0] || null;
}

async function commitPatchId(commit: string): Promise<string | null> {
  return stablePatchId(await git(["show", "--pretty=format:", "--no-ext-diff", commit]));
}

interface ProdPatchIndex {
  positions: Map<string, number>;
  patchIds: Map<string, string>;
}

let prodPatchIndexCache:
  | { tip: string; index: Promise<ProdPatchIndex> }
  | undefined;

async function prodPatchIndex(): Promise<ProdPatchIndex> {
  const tip = await git(["rev-parse", "origin/prod"]);
  if (prodPatchIndexCache?.tip === tip) return prodPatchIndexCache.index;

  const index = (async () => {
    const prodCommits = (await git([
      "rev-list",
      `--max-count=${PATCH_SCAN_COMMIT_LIMIT}`,
      "origin/prod",
    ]))
      .split("\n")
      .filter(Boolean);
    const positions = new Map(
      prodCommits.map((commit, position) => [commit, position]),
    );
    const patchIds = new Map<string, string>();
    const output = await git(
      ["patch-id", "--stable"],
      await git([
        "log",
        `--max-count=${PATCH_SCAN_COMMIT_LIMIT}`,
        "--no-merges",
        "--pretty=format:%H",
        "-p",
        "--no-ext-diff",
        "origin/prod",
      ]),
    );
    for (const line of output.split("\n")) {
      const [patchId, commit] = line.trim().split(/\s+/);
      if (
        patchId &&
        commit &&
        positions.has(commit) &&
        !patchIds.has(patchId)
      ) {
        // git log is newest-first, so retain the first occurrence.
        patchIds.set(patchId, commit);
      }
    }
    return { positions, patchIds };
  })();
  prodPatchIndexCache = { tip, index };
  try {
    return await index;
  } catch (error) {
    if (prodPatchIndexCache?.index === index) prodPatchIndexCache = undefined;
    throw error;
  }
}

async function findPatchEquivalentProdCommit(
  details: PullRequestDetails,
  commits: PullRequestCommit[],
): Promise<string | null> {
  const prod = await prodPatchIndex();

  // A squash merge or a cherry-pick of a squash has the same aggregate patch
  // as the PR even though none of its individual commit SHAs survive.
  const mergeBase = await git(["merge-base", details.base.sha, details.head.sha]);
  const aggregatePatch = await git([
    "diff",
    "--no-ext-diff",
    mergeBase,
    details.head.sha,
  ]);
  const aggregatePatchId = await stablePatchId(aggregatePatch);
  if (aggregatePatchId && prod.patchIds.has(aggregatePatchId)) {
    return prod.patchIds.get(aggregatePatchId)!;
  }

  // A PR can also be cherry-picked one commit at a time. Only declare it
  // present after every non-empty PR commit has a patch-equivalent prod commit.
  const matches: Array<{ commit: string; position: number }> = [];
  for (const commit of commits) {
    const patchId = await commitPatchId(commit.sha);
    if (!patchId) continue;
    const match = prod.patchIds.get(patchId);
    if (!match) return null;
    const position = prod.positions.get(match);
    if (position === undefined) return null;
    matches.push({ commit: match, position });
  }
  if (matches.length === 0) return null;
  matches.sort((left, right) => left.position - right.position);
  return matches[0]?.commit ?? null;
}

export async function findPullRequestOnProd(
  details: PullRequestDetails,
  commits: PullRequestCommit[],
): Promise<string | null> {
  await fetchWatchRefs(details.number);
  if (
    details.merge_commit_sha &&
    (await isAncestor(details.merge_commit_sha, "origin/prod"))
  ) {
    return details.merge_commit_sha;
  }
  return findPatchEquivalentProdCommit(details, commits);
}

async function isCommitLiveOnRender(commit: string): Promise<boolean> {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) throw new Error("RENDER_API_KEY is required for PR watches");
  const serviceId = await productionCmServiceId(apiKey);
  const response = await fetch(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys?limit=20`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`Render deploy lookup failed with HTTP ${response.status}`);
  }
  const page = (await response.json()) as Array<RenderDeployPageItem | RenderDeploy>;
  const deploys: RenderDeploy[] = page.map(
    (item) => (item as RenderDeployPageItem).deploy ?? (item as RenderDeploy),
  );
  const liveCommit = deploys.find((deploy) => deploy.status === "live")?.commit?.id;
  return Boolean(liveCommit && (await isAncestor(commit, liveCommit)));
}

let renderServiceCache:
  | { serviceId: string; expiresAt: number }
  | undefined;

function isCompRepository(repo: string | undefined): boolean {
  return Boolean(
    repo &&
      /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|github\.com\/)comprehensiveio\/comp(?:\.git)?\/?$/i.test(repo),
  );
}

async function renderPage<T>(
  apiKey: string,
  path: string,
  query: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`https://api.render.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Render ${path} lookup failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T[];
}

async function productionCmServiceId(apiKey: string): Promise<string> {
  if (renderServiceCache && renderServiceCache.expiresAt > Date.now()) {
    return renderServiceCache.serviceId;
  }

  const projects = await renderPage<RenderProjectPageItem>(
    apiKey,
    "/v1/projects",
    { name: RENDER_PROJECT_NAME, limit: "100" },
  );
  const project = projects.find(
    (item) => item.project?.name === RENDER_PROJECT_NAME,
  )?.project;
  if (!project?.id) throw new Error(`Render project ${RENDER_PROJECT_NAME} was not found`);

  const environments = await renderPage<RenderEnvironmentPageItem>(
    apiKey,
    "/v1/environments",
    {
      projectId: project.id,
      name: RENDER_ENVIRONMENT_NAME,
      limit: "100",
    },
  );
  const environment = environments.find(
    (item) => item.environment?.name === RENDER_ENVIRONMENT_NAME,
  )?.environment;
  if (!environment?.id) {
    throw new Error(
      `Render environment ${RENDER_PROJECT_NAME} / ${RENDER_ENVIRONMENT_NAME} was not found`,
    );
  }

  const services = await renderPage<RenderServicePageItem>(
    apiKey,
    "/v1/services",
    {
      environmentId: environment.id,
      includePreviews: "false",
      limit: "100",
    },
  );
  const serviceId = selectProductionCmServiceId(
    services.map((item) => item.service).filter(Boolean) as RenderService[],
  );
  renderServiceCache = {
    serviceId,
    expiresAt: Date.now() + RENDER_SERVICE_CACHE_MS,
  };
  return serviceId;
}

export function selectProductionCmServiceId(
  services: RenderService[],
): string {
  const matches = services
    .filter(
      (service): service is RenderService & { id: string } =>
        Boolean(
          service?.id &&
            service.name?.startsWith(RENDER_SERVICE_NAME_PREFIX) &&
            service.type === "web_service" &&
            service.branch === "prod" &&
            service.suspended !== "suspended" &&
            isCompRepository(service.repo),
        ),
    );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one active ${RENDER_SERVICE_NAME_PREFIX} service in ${RENDER_PROJECT_NAME} / ${RENDER_ENVIRONMENT_NAME}; found ${matches.length}`,
    );
  }
  return matches[0]!.id;
}

export class PullRequestWatchService {
  private readonly pool: pg.Pool;
  private readonly slack: SlackClient;

  constructor(options: { connectionString: string; botToken: string; teamId: string }) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      ssl: sslForConnectionString(options.connectionString),
      max: 2,
      allowExitOnIdle: true,
      application_name: "compadre-pr-watch",
    });
    this.slack = new SlackClient({ botToken: options.botToken, teamId: options.teamId });
    this.pool.on("error", (error) =>
      console.error("[pr-watch] idle Postgres connection failed", error),
    );
  }

  async initialize(): Promise<void> {
    await this.pool.query(PR_WATCH_SCHEMA);
  }

  async register(
    request: PullRequestWatchRequest,
    destination: PullRequestWatchDestination,
  ): Promise<{ created: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO compadre_pr_watches (
         id, pr_number, pr_url, slack_team_id, slack_channel_id, slack_thread_ts
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pr_number, slack_team_id, slack_channel_id, slack_thread_ts)
       DO NOTHING`,
      [
        randomUUID(),
        request.prNumber,
        request.prUrl,
        destination.teamId,
        destination.channelId,
        destination.threadTs,
      ],
    );
    return { created: result.rowCount === 1 };
  }

  async reconcile(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('compadre-pr-watch-reconcile')) AS locked",
      );
      if (!lock.rows[0]?.locked) return;
      await this.recoverStaleDeliveries(client);
      const watches = await client.query<WatchRow>(
        `SELECT id, pr_number, pr_url, slack_team_id, slack_channel_id,
                slack_thread_ts, matched_prod_commit
         FROM compadre_pr_watches WHERE status = 'waiting'
         ORDER BY created_at ASC LIMIT 100`,
      );
      for (const watch of watches.rows) {
        await this.reconcileOne(watch).catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[pr-watch] PR #${watch.pr_number} reconciliation failed:`, error);
          await this.pool.query(
            `UPDATE compadre_pr_watches SET checked_at = now(), last_error = $2
             WHERE id = $1 AND status = 'waiting'`,
            [watch.id, message.slice(0, 2000)],
          );
        });
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('compadre-pr-watch-reconcile'))")
        .catch(() => undefined);
      client.release();
    }
  }

  private async reconcileOne(watch: WatchRow): Promise<void> {
    const details = await githubJson<PullRequestDetails>(
      `/repos/${REPOSITORY}/pulls/${watch.pr_number}`,
    );
    if (details.state === "closed" && !details.merged) {
      await this.deliver(watch, "closed_unmerged", null,
        `PR #${watch.pr_number} was closed without merging, so I stopped watching it.`);
      await this.cleanUpWatchRef(watch.pr_number);
      return;
    }
    if (!details.merged) {
      await this.markChecked(watch.id);
      return;
    }
    const commits = await githubPullRequestCommits(watch.pr_number);
    const prodCommit = await findPullRequestOnProd(details, commits);
    if (!prodCommit || !(await isCommitLiveOnRender(prodCommit))) {
      await this.markChecked(watch.id);
      return;
    }
    await this.deliver(
      watch,
      "notified",
      prodCommit,
      `PR #${watch.pr_number} is now live in production. ${watch.pr_url}`,
    );
    await this.cleanUpWatchRef(watch.pr_number);
  }

  private async recoverStaleDeliveries(client: pg.PoolClient): Promise<void> {
    const stale = await client.query<WatchRow>(
      `SELECT id, pr_number, pr_url, slack_team_id, slack_channel_id,
              slack_thread_ts, matched_prod_commit
       FROM compadre_pr_watches
       WHERE status = 'delivering'
         AND delivery_started_at <=
           now() - make_interval(secs => $1::double precision)`,
      [STALE_DELIVERY_MS / 1000],
    );
    for (const watch of stale.rows) {
      const text = watch.matched_prod_commit
        ? `PR #${watch.pr_number} is now live in production. ${watch.pr_url}`
        : `PR #${watch.pr_number} was closed without merging, so I stopped watching it.`;
      try {
        const response = await this.slack.getThreadReplies(
          watch.slack_channel_id,
          watch.slack_thread_ts,
        );
        const messages = Array.isArray(response.messages)
          ? response.messages as Array<{ client_msg_id?: string; text?: string }>
          : [];
        const delivered = messages.some(
          (message) =>
            message.client_msg_id === watch.id || message.text === text,
        );
        if (delivered) {
          await client.query(
            `UPDATE compadre_pr_watches
             SET status = $2, notified_at = now(), delivery_started_at = NULL,
                 last_error = NULL
             WHERE id = $1 AND status = 'delivering'`,
            [
              watch.id,
              watch.matched_prod_commit ? "notified" : "closed_unmerged",
            ],
          );
          await this.cleanUpWatchRef(watch.pr_number);
        } else {
          await client.query(
            `UPDATE compadre_pr_watches
             SET status = 'waiting', matched_prod_commit = NULL,
                 delivery_started_at = NULL
             WHERE id = $1 AND status = 'delivering'`,
            [watch.id],
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await client.query(
          `UPDATE compadre_pr_watches SET checked_at = now(), last_error = $2
           WHERE id = $1 AND status = 'delivering'`,
          [watch.id, message.slice(0, 2000)],
        );
      }
    }
  }

  private async cleanUpWatchRef(prNumber: number): Promise<void> {
    await deleteWatchRef(prNumber).catch((error) =>
      console.error(`[pr-watch] failed to clean up PR #${prNumber} ref:`, error),
    );
  }

  private async markChecked(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE compadre_pr_watches
       SET checked_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'waiting'`,
      [id],
    );
  }

  private async deliver(
    watch: WatchRow,
    finalStatus: "notified" | "closed_unmerged",
    prodCommit: string | null,
    text: string,
  ): Promise<void> {
    const claim = await this.pool.query(
      `UPDATE compadre_pr_watches
       SET status = 'delivering', checked_at = now(), delivery_started_at = now(),
           matched_prod_commit = $2
       WHERE id = $1 AND status = 'waiting' RETURNING id`,
      [watch.id, prodCommit],
    );
    if (claim.rowCount !== 1) return;
    try {
      await this.slack.replyToThread(watch.slack_channel_id, watch.slack_thread_ts, text, watch.id);
      await this.pool.query(
        `UPDATE compadre_pr_watches
         SET status = $2, matched_prod_commit = $3, notified_at = now(),
             delivery_started_at = NULL, last_error = NULL
         WHERE id = $1 AND status = 'delivering'`,
        [watch.id, finalStatus, prodCommit],
      );
    } catch (error) {
      await this.pool.query(
        `UPDATE compadre_pr_watches
         SET last_error = $2
         WHERE id = $1 AND status = 'delivering'`,
        [watch.id, error instanceof Error ? error.message : String(error)],
      ).catch((databaseError) =>
        console.error("[pr-watch] failed to record delivery error:", databaseError),
      );
      throw error;
    }
  }
}

let configuredService: Promise<PullRequestWatchService | null> | undefined;

export function getConfiguredPullRequestWatchService(): Promise<PullRequestWatchService | null> {
  if (!configuredService) {
    const initialization = (async () => {
      const connectionString = process.env.COMPADRE_DURABILITY_DATABASE_URL;
      const botToken = process.env.SLACK_BOT_TOKEN;
      const teamId = process.env.SLACK_TEAM_ID;
      if (!connectionString || !botToken || !teamId) return null;
      const service = new PullRequestWatchService({ connectionString, botToken, teamId });
      await service.initialize();
      return service;
    })().catch((error) => {
      if (configuredService === initialization) configuredService = undefined;
      throw error;
    });
    configuredService = initialization;
  }
  return configuredService;
}

export function startPullRequestWatchReconciler(
  service: PullRequestWatchService,
  intervalMs = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  const reconcile = () =>
    void service.reconcile().catch((error) =>
      console.error("[pr-watch] reconciliation failed:", error),
    );
  reconcile();
  const timer = setInterval(reconcile, intervalMs);
  timer.unref();
  return timer;
}
