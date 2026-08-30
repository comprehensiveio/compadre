import {
  resumeServerSentEventsResponse,
  type StreamDurability,
} from "@tanstack/ai";

/**
 * Bind one durable event log to an HTTP subscriber's resume cursor.
 *
 * Producers never receive the request signal through this module. Closing a
 * browser or rolling a proxy connection detaches only this reader; explicit
 * cancellation travels through the run coordinator instead.
 */
export function resumableStreamForRequest(
  stream: StreamDurability<string>,
  request: Request,
  defaultOffset: string | null = null,
): StreamDurability<string> {
  const offset =
    request.headers.get("Last-Event-ID") ||
    new URL(request.url).searchParams.get("offset") ||
    defaultOffset;
  return {
    resumeFrom: () => offset,
    append: (chunks) => stream.append(chunks),
    read: (streamOffset, signal) => stream.read(streamOffset, signal),
    close: () => stream.close(),
    snapshot: () => stream.snapshot(),
  };
}

export function durableRunEventsResponse(
  stream: StreamDurability<string>,
  request: Request,
  headers: HeadersInit = {},
  defaultOffset: string | null = null,
): Response {
  return resumeServerSentEventsResponse({
    adapter: resumableStreamForRequest(stream, request, defaultOffset),
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}
