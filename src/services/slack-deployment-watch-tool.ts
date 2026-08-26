import type { PullRequestWatchService } from "./pr-watch.js";

export interface SlackDeploymentWatchToolInput {
  prNumber: number;
  channelId: string;
  threadTs: string;
}

export interface SlackDeploymentWatchToolDependencies {
  teamId: string;
  getWatchService(): Promise<PullRequestWatchService>;
}

/** Provider-neutral handler behind the Slack MCP deployment-watch tool. */
export async function watchCompPrDeployment(
  input: SlackDeploymentWatchToolInput,
  dependencies: SlackDeploymentWatchToolDependencies,
) {
  const watchService = await dependencies.getWatchService();
  const prUrl = `https://github.com/comprehensiveio/comp/pull/${input.prNumber}`;
  const result = await watchService.register(
    { prNumber: input.prNumber, prUrl },
    {
      teamId: dependencies.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
    },
  );
  return {
    ...result,
    pr_number: input.prNumber,
    pr_url: prUrl,
    message: result.created
      ? `Watching PR #${input.prNumber} for production deployment.`
      : `PR #${input.prNumber} is already being watched in this thread.`,
  };
}
