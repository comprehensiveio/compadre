export const DEFAULT_MAX_TURNS = Number(process.env.DEFAULT_MAX_TURNS) || 50;
export const DEFAULT_MAX_BUDGET_USD = Number(process.env.DEFAULT_MAX_BUDGET_USD) || 3.0;
export const REPO_PATH = process.env.REPO_PATH || "/opt/render/repo";
export const SLACK_STREAMING_ENABLED = process.env.SLACK_STREAMING_ENABLED !== "false";
