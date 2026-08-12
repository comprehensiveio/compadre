import { ensureRepo } from "../repo.js";
import {
  getConfiguredPullRequestWatchService,
  startPullRequestWatchReconciler,
  type PullRequestWatchService,
} from "./pr-watch.js";

interface PullRequestWatchRuntimeDependencies {
  getService: () => Promise<PullRequestWatchService | null>;
  ensureRepository: () => void;
  startReconciler: (service: PullRequestWatchService) => unknown;
}

const defaultDependencies: PullRequestWatchRuntimeDependencies = {
  getService: getConfiguredPullRequestWatchService,
  ensureRepository: ensureRepo,
  startReconciler: startPullRequestWatchReconciler,
};

export async function startConfiguredPullRequestWatch(
  repositoryReady: boolean,
  dependencies: PullRequestWatchRuntimeDependencies = defaultDependencies,
): Promise<void> {
  const service = await dependencies.getService();
  if (!service) return;
  if (!repositoryReady) dependencies.ensureRepository();
  dependencies.startReconciler(service);
}
