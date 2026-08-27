/**
 * The small AG-UI wire contract emitted by the native T3 bridge.
 *
 * Keeping this local avoids making T3 orchestration depend on a particular AI
 * runtime. The string values remain AG-UI compatible for existing clients.
 */
export const EventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  THREAD_TOKEN_USAGE_UPDATED: "THREAD_TOKEN_USAGE_UPDATED",
} as const;

export const NATIVE_T3_PROTOCOL_VERSION = 2 as const;
export const NATIVE_T3_PROTOCOL_HEADER = "X-Compadre-T3-Protocol-Version";

/** Reserved now so future authentication can attribute every persisted event. */
export interface NativeT3Actor {
  type: "user" | "slack" | "system" | "unknown";
  id?: string;
  displayName?: string;
}

export interface StreamChunk {
  type: string;
  protocolVersion?: typeof NATIVE_T3_PROTOCOL_VERSION;
  actor?: NativeT3Actor;
  timestamp?: number;
  runId?: string;
  threadId?: string;
  messageId?: string;
  role?: string;
  delta?: string;
  content?: string;
  toolCallId?: string;
  toolCallName?: string;
  toolName?: string;
  args?: string;
  itemType?: string;
  title?: string;
  detail?: string;
  data?: unknown;
  status?: string;
  finishReason?: string | null;
  message?: string;
  usage?: Record<string, unknown>;
}

export function toServerSentEventsResponse(
  source: AsyncIterable<StreamChunk>,
  options: { headers?: HeadersInit } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of source) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...Object.fromEntries(new Headers(options.headers).entries()),
    },
  });
}
