import { createHmac } from "node:crypto";
import { DEFAULT_MODAL_TIMEOUT_MS } from "../modal-config.js";

/** Reissued on provisioning/restore; never exposes the signing key to Modal. */
export function pullRequestAccessProjection(
  environment: NodeJS.ProcessEnv,
  now: () => number = Date.now,
): Record<string, string> {
  const threadId = environment.COMPADRE_CANONICAL_THREAD_ID?.trim();
  if (!threadId) return {};
  const secret = environment.COMPADRE_API_KEY?.trim();
  const publicUrl = environment.COMPADRE_PUBLIC_URL?.trim();
  if (!secret || !publicUrl) throw new Error("Hosted PR access requires COMPADRE_API_KEY and COMPADRE_PUBLIC_URL");
  const lifetime = Number(environment.COMPADRE_MODAL_TIMEOUT_MS || DEFAULT_MODAL_TIMEOUT_MS);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new Error("Invalid Modal worker lifetime");
  const payload = Buffer.from(JSON.stringify({
    threadId,
    expiresAt: Math.ceil((now() + lifetime + 300_000) / 1000),
  })).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`compadre:pull-requests:v1:${payload}`).digest("base64url");
  return {
    COMPADRE_PULL_REQUESTS_URL: new URL("/internal/t3-pull-requests", publicUrl).toString(),
    COMPADRE_PULL_REQUESTS_TOKEN: `${payload}.${signature}`,
  };
}

/** Modal reaches the public controller; central T3 may have only a private service address. */
export async function forwardPullRequestRequest(input: {
  authorization: string;
  body: unknown;
  environment?: NodeJS.ProcessEnv;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): Promise<Response> {
  const environment = input.environment ?? process.env;
  const centralUrl = environment.COMPADRE_T3_CENTRAL_URL?.trim() || environment.COMPADRE_T3_HOSTED_APP_URL?.trim();
  if (!centralUrl) return new Response(null, { status: 503 });
  try {
    const response = await (input.fetch ?? fetch)(new URL("/api/compadre/pull-requests", centralUrl), {
      method: "POST",
      headers: { authorization: input.authorization, "content-type": "application/json" },
      body: JSON.stringify(input.body),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    // Old central versions may serve the SPA at an unknown route. Never report that as success.
    if (response.headers.get("x-compadre-pull-requests-version") !== "1") {
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
