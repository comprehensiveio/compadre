import { githubNoreplyEmail, normalizeGithubLogin } from "./github-login.js";

/**
 * Worker commits are authored by the shared Compadre git identity, so the
 * human who asked for the change only appears in Slack or the web thread.
 * A repo-local `prepare-commit-msg` hook appends a `Co-authored-by` trailer
 * naming the current requester; GitHub carries those trailers into the
 * squash-merge commit and credits the person on the merged PR.
 *
 * The hook reads the trailer from a file the controller rewrites before every
 * turn, so a thread whose requester changes between turns credits the right
 * person and a turn with no attributable human (API or trigger) adds nothing.
 */
export const CO_AUTHOR_DIR = "/home/node/.compadre";
export const CO_AUTHOR_FILE = `${CO_AUTHOR_DIR}/co-author`;
export const CO_AUTHOR_HOOK_PATH = `${CO_AUTHOR_DIR}/prepare-commit-msg`;

export const CO_AUTHOR_HOOK_SCRIPT = `#!/bin/sh
# Installed by Compadre: credit the requesting user on every worker commit.
co_author_file="${CO_AUTHOR_FILE}"
[ -s "$co_author_file" ] || exit 0
trailer=$(head -n 1 "$co_author_file")
[ -n "$trailer" ] || exit 0
git interpret-trailers --in-place --if-exists addIfDifferent --trailer "$trailer" "$1"
`;

export interface CoAuthorUser {
  displayName: string;
  realName?: string;
  email?: string;
  githubLogin?: string;
}

function trailerSafe(value: string): string {
  return value.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Full `Co-authored-by` trailer for a user. A stored GitHub username wins:
 * its noreply address links to the account regardless of which emails the
 * person verified on GitHub. Otherwise the Slack email is used, which GitHub
 * links only when the same address is verified on the account. Undefined
 * when neither is usable.
 */
export function coAuthorTrailer(user: CoAuthorUser | null | undefined): string | undefined {
  if (!user) return undefined;
  const login = normalizeGithubLogin(user.githubLogin);
  const email = login ? githubNoreplyEmail(login) : trailerSafe(user.email ?? "");
  if (!email || !email.includes("@")) return undefined;
  const name = trailerSafe(user.realName ?? "") || trailerSafe(user.displayName) || login || email;
  return `Co-authored-by: ${name} <${email}>`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shell that installs the hook into the checked-out repository. Idempotent so
 * it can run on each turn, which also covers workers restored from older
 * snapshots. The trailer file itself is written separately.
 */
export function buildCoAuthorInstallCommand(repoPath: string): string {
  return `if [ -d ${quote(`${repoPath}/.git`)} ]; then install -m 755 ${quote(CO_AUTHOR_HOOK_PATH)} ${quote(`${repoPath}/.git/hooks/prepare-commit-msg`)}; fi`;
}

export interface CoAuthorSandbox {
  readonly workspaceRoot?: string;
  readonly fs: { write(path: string, contents: string): Promise<void> };
  readonly process: {
    exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
}

/** Record the trailer (empty clears it) and install the hook into the checkout. */
export async function projectCoAuthor(
  sandbox: CoAuthorSandbox,
  repoPath: string,
  trailer: string | undefined,
): Promise<void> {
  const prepared = await sandbox.process.exec(`mkdir -p ${quote(CO_AUTHOR_DIR)}`);
  if (prepared.exitCode !== 0) throw new Error(prepared.stderr || prepared.stdout);
  await sandbox.fs.write(CO_AUTHOR_HOOK_PATH, CO_AUTHOR_HOOK_SCRIPT);
  await sandbox.fs.write(CO_AUTHOR_FILE, trailer ? `${trailer}\n` : "");
  const installed = await sandbox.process.exec(buildCoAuthorInstallCommand(repoPath));
  if (installed.exitCode !== 0) throw new Error(installed.stderr || installed.stdout);
}
