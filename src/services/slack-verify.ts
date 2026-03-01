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
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || Math.abs(now - ts) > MAX_TIMESTAMP_DIFF_S) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}
