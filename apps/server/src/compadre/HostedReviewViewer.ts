import * as Context from "effect/Context";

/** Canonical browser identity supplied by authenticated RPC admission, never by request input. */
export class HostedReviewViewer extends Context.Reference<string | null>(
  "compadre/HostedReviewViewer",
  { defaultValue: () => null },
) {}
