export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5";
export const FABLE_MODEL = process.env.FABLE_MODEL || "claude-fable-5";
export const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.6-sol";
export const REPO_PATH = process.env.REPO_PATH || "/tmp/comp-repo";
// Retained for the legacy local worktree helper, which is no longer used on
// the production request path.
export const PREPARED_WORKTREE_TARGET = Number(
  process.env.COMPADRE_PREPARED_WORKTREES ?? 1,
);
