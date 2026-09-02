import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
const { runConversation } = await import("../src/conversation.js");

const prompt = process.argv.slice(2).join(" ") || "Reply with only: hi";
const startedAt = Date.now();
let firstTextAt: number | undefined;

const result = await runConversation({
  threadId: `cold-start-benchmark-${startedAt}`,
  prompt,
  stream: {
    onTextDelta(text) {
      firstTextAt ??= Date.now();
      process.stdout.write(text);
    },
    onToolStart(name) {
      process.stdout.write(
        `\ntool_start_ms=${Date.now() - startedAt} name=${name}\n`,
      );
    },
  },
});

process.stdout.write(
  `\nfirst_text_ms=${firstTextAt === undefined ? -1 : firstTextAt - startedAt}` +
    `\ntotal_ms=${Date.now() - startedAt}` +
    `\nprovider=${result.provider}` +
    `\nmodel=${result.model}` +
    `\nresult=${result.result}\n`,
);
