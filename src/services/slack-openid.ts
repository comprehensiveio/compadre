import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

const SLACK_ISSUER = "https://slack.com";
const slackJwks = createRemoteJWKSet(new URL("https://slack.com/openid/connect/keys"));

const SlackTokenResponse = z.object({
  ok: z.literal(true),
  id_token: z.string().min(1),
});

export interface SlackOpenIdConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function slackAuthorizeUrl(input: {
  config: SlackOpenIdConfig;
  state: string;
  nonce: string;
  codeChallenge: string;
  workspaceId?: string;
}): string {
  const url = new URL("https://slack.com/openid/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.workspaceId) url.searchParams.set("team", input.workspaceId);
  return url.toString();
}

export async function exchangeSlackOpenIdCode(input: {
  config: SlackOpenIdConfig;
  code: string;
  codeVerifier: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const response = await (input.fetch ?? globalThis.fetch)(
    "https://slack.com/api/openid.connect.token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        code: input.code,
        redirect_uri: input.config.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    },
  );
  const decoded = SlackTokenResponse.safeParse(await response.json().catch(() => null));
  if (!response.ok || !decoded.success) {
    throw new Error("Slack rejected the OpenID code exchange");
  }
  return decoded.data.id_token;
}

export async function verifySlackOpenIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string;
}): Promise<JWTPayload> {
  const { payload } = await jwtVerify(input.idToken, slackJwks, {
    issuer: SLACK_ISSUER,
    audience: input.clientId,
  });
  if (payload.nonce !== input.nonce) {
    throw new Error("Slack OpenID nonce did not match");
  }
  return payload;
}

export function slackSubjectFromClaims(payload: JWTPayload): {
  workspaceId: string;
  slackUserId: string;
} {
  const workspaceId = payload["https://slack.com/team_id"];
  const slackUserId = payload["https://slack.com/user_id"] ?? payload.sub;
  if (typeof workspaceId !== "string" || typeof slackUserId !== "string") {
    throw new Error("Slack OpenID token did not contain a workspace and user");
  }
  return { workspaceId, slackUserId };
}
