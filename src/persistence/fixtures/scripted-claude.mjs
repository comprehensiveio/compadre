let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const resumed = process.argv.includes("--resume");
const turn = resumed || prompt.includes("second") ? "second" : "first";
const toolCallId = `${turn}-tool`;
const answerId = `${turn}-answer`;
const events = [
  {
    type: "system",
    subtype: "init",
    session_id: "scripted-session",
    model: "scripted-claude",
    tools: ["Bash"],
  },
  {
    type: "assistant",
    message: {
      id: `${turn}-tool-message`,
      content: [
        {
          type: "tool_use",
          id: toolCallId,
          name: "Bash",
          input: { command: `printf ${turn}` },
        },
      ],
    },
    parent_tool_use_id: null,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolCallId,
          content: turn === "first" ? "one" : "two",
        },
      ],
    },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "message_start", message: { id: answerId } },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `${turn} answer` },
    },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
    parent_tool_use_id: null,
  },
  {
    type: "assistant",
    message: {
      id: answerId,
      content: [{ type: "text", text: `${turn} answer` }],
    },
    parent_tool_use_id: null,
  },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0,
  },
];

process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
