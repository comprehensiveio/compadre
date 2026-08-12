import type { ChatMiddleware } from "@tanstack/ai";

/**
 * Keep a middleware's setup/config/stream hooks in place while deferring its
 * terminal side effects until later middleware have reconciled their state.
 */
export function deferTerminalHooks(middleware: ChatMiddleware): {
  lifecycle: ChatMiddleware;
  terminal: ChatMiddleware;
} {
  const { onFinish, onAbort, onError, ...rest } = middleware;
  const baseName = middleware.name ?? "middleware";
  const lifecycle: ChatMiddleware = {
    ...rest,
    name: `${baseName}-lifecycle`,
  };
  const terminal: ChatMiddleware = {
    name: `${baseName}-terminal`,
    ...(onFinish ? { onFinish } : {}),
    ...(onAbort ? { onAbort } : {}),
    ...(onError ? { onError } : {}),
  };
  return { lifecycle, terminal };
}
