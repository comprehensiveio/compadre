import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { CompadreDatabase } from "../db/client.js";
import { authLoginFlows, authLoginGrants } from "../db/schema.js";

const LOGIN_FLOW_TTL_MS = 10 * 60 * 1_000;
const LOGIN_GRANT_TTL_MS = 60 * 1_000;

function token(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashAuthSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export function normalizeAuthReturnTo(value: string | undefined): string {
  if (!value) return "/";
  const decoded = value.trim();
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    return "/";
  }
  return decoded;
}

export interface PendingSlackLogin {
  state: string;
  nonce: string;
  returnTo: string;
}

export interface ConsumedSlackLogin {
  nonce: string;
  returnTo: string;
}

export class AuthStore {
  constructor(
    private readonly db: CompadreDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beginSlackLogin(returnToInput?: string): Promise<PendingSlackLogin> {
    const state = token();
    const nonce = token();
    const returnTo = normalizeAuthReturnTo(returnToInput);
    const now = this.now();
    await this.db.insert(authLoginFlows).values({
      stateHash: hashAuthSecret(state),
      nonce,
      returnTo,
      createdAt: now,
      expiresAt: new Date(now.getTime() + LOGIN_FLOW_TTL_MS),
    });
    return { state, nonce, returnTo };
  }

  async consumeSlackLogin(state: string): Promise<ConsumedSlackLogin | null> {
    const now = this.now();
    const rows = await this.db
      .update(authLoginFlows)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginFlows.stateHash, hashAuthSecret(state)),
          isNull(authLoginFlows.consumedAt),
          gt(authLoginFlows.expiresAt, now),
        ),
      )
      .returning({
        nonce: authLoginFlows.nonce,
        returnTo: authLoginFlows.returnTo,
      });
    return rows[0] ?? null;
  }

  async issueLoginGrant(userId: string, returnToInput?: string): Promise<string> {
    const code = token();
    const now = this.now();
    await this.db.insert(authLoginGrants).values({
      codeHash: hashAuthSecret(code),
      userId,
      returnTo: normalizeAuthReturnTo(returnToInput),
      createdAt: now,
      expiresAt: new Date(now.getTime() + LOGIN_GRANT_TTL_MS),
    });
    return code;
  }

  async consumeLoginGrant(
    code: string,
  ): Promise<{ userId: string; returnTo: string } | null> {
    const now = this.now();
    const rows = await this.db
      .update(authLoginGrants)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginGrants.codeHash, hashAuthSecret(code)),
          isNull(authLoginGrants.consumedAt),
          gt(authLoginGrants.expiresAt, now),
        ),
      )
      .returning({
        userId: authLoginGrants.userId,
        returnTo: authLoginGrants.returnTo,
      });
    return rows[0] ?? null;
  }
}
