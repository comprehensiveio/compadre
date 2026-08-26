import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
process.env.COMPADRE_MCP_ALLOW_PARTIAL ??= "true";
if (
  !process.env.COMPADRE_DURABILITY_BACKEND ||
  process.env.COMPADRE_DURABILITY_BACKEND === "off"
) {
  process.env.COMPADRE_DURABILITY_BACKEND = "memory";
}

const { runSlackSimulation, slackSimulationSummary } = await import(
  "../src/services/slack-simulation.js"
);
const messageText =
  process.argv.slice(2).join(" ").trim() ||
  "Reply with exactly: SLACK-SIMULATION-OK";

process.stderr.write(
  "[slack-simulation] using an in-memory Slack delivery sink; no Slack API calls will be made\n",
);

const simulation = await runSlackSimulation({
  messageText,
  onTextDelta(text) {
    process.stdout.write(text);
  },
  onToolStart(name) {
    process.stderr.write(`[slack-simulation] tool=${name}\n`);
  },
  onAutoContinue() {
    process.stderr.write("[slack-simulation] auto-continuing\n");
  },
});

process.stdout.write(
  `\n${JSON.stringify(slackSimulationSummary(simulation), null, 2)}\n`,
);
