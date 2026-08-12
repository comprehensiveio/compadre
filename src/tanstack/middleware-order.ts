import type { ChatMiddleware } from "@tanstack/ai";

/**
 * Keep a middleware's setup/config/stream hooks in place while deferring its
 * terminal side effects until later middleware have reconciled their state.
 */
export function deferTerminalHooks(middleware: ChatMiddleware): {
  lifecycle: ChatMiddleware;
  terminal: ChatMiddleware;
} {
  const { onFinish, onAbort, onError, ...lifecycle } = middleware;
  const terminal: ChatMiddleware = {
    name: `${middleware.name ?? "middleware"}-terminal`,
    ...(onFinish ? { onFinish } : {}),
    ...(onAbort ? { onAbort } : {}),
    ...(onError ? { onError } : {}),
  };
  return { lifecycle, terminal };
}
