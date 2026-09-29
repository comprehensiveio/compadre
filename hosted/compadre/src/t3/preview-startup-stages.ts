// Worker checkouts can predate this protocol. Ignore ordinary output and only
// forward bounded, fixed-label timing records; startup output can hold secrets.
export function parsePreviewStartupStages(stdout: string) {
  const stages = new Map<string, { stage: string; elapsedMs: number; exitCode: number }>();
  for (const line of stdout.split("\n")) {
    const match = /^compadre-dev-stage-v1 (bootstrap|services|launch|readiness) (\d{1,5}) (\d{1,3})$/.exec(line);
    if (!match) continue;
    const [, stage, seconds, code] = match;
    if (!stage || !seconds || !code) continue;
    const exitCode = Number(code);
    if (exitCode > 255) continue;
    stages.set(stage, { stage, elapsedMs: Number(seconds) * 1_000, exitCode });
  }
  return [...stages.values()];
}
