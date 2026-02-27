import crypto from "crypto";

const MAX_TIMESTAMP_DIFF_S = 300;

export function verifySlackSignature({
  signingSecret,
  signature,
  timestamp,
  body,
}: {
  signingSecret: string;
  signature: string;
  timestamp: string;
  body: string;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_DIFF_S) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
