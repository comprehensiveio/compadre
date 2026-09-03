import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { LockStore, MetadataStore } from "./storage.js";

const NAMESPACE = "compadre.codex-subscription-lane.v1";
const STATE_KEY = "state";
const LOCK_KEY = "compadre:codex-subscription-lane:v1";

export type CodexAuthRoute = "api" | "subscription";
export type CodexAuthRouteReason =
  | "legacy_unmanaged"
  | "experiment_disabled"
  | "existing_route"
  | "owner_recovered"
  | "lane_busy"
  | "lane_available"
  | "lane_error";

interface EncryptedAuth {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface LaneState {
  version: 1;
  auth: EncryptedAuth;
  seedDigest: string;
  owner?: {
    canonicalThreadId: string;
    runId: string;
    claimedAt: string;
  };
  routes?: Record<
    string,
    { route: CodexAuthRoute; runId: string; assignedAt: string }
  >;
}

export interface CodexSubscriptionClaim {
  route: CodexAuthRoute;
  reason: CodexAuthRouteReason;
  authJson?: string;
  /** False for a steer/retry already owned by this thread. */
  requiresConfiguration: boolean;
}

function decodeBase64(name: string, value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new Error(`${name} must contain valid base64`);
  }
  return Buffer.from(normalized, "base64");
}

function encryptionKey(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.COMPADRE_CODEX_AUTH_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new Error(
      "COMPADRE_CODEX_AUTH_ENCRYPTION_KEY is required when the Codex subscription experiment is enabled",
    );
  }
  const key = decodeBase64("COMPADRE_CODEX_AUTH_ENCRYPTION_KEY", encoded);
  if (key.byteLength !== 32) {
    throw new Error(
      "COMPADRE_CODEX_AUTH_ENCRYPTION_KEY must decode to 32 bytes",
    );
  }
  return key;
}

function assertSubscriptionAuthJson(authJson: string): void {
  try {
    const parsed = JSON.parse(authJson) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    if (
      parsed.auth_mode !== "chatgpt" ||
      typeof tokens?.refresh_token !== "string" ||
      !tokens.refresh_token
    ) {
      throw new Error("not ChatGPT-managed auth");
    }
  } catch {
    throw new Error("Codex auth must be ChatGPT-managed auth.json");
  }
}

function subscriptionAuth(environment: NodeJS.ProcessEnv): string {
  const encoded = environment.CODEX_AUTH_JSON_BASE64?.trim();
  if (!encoded) {
    throw new Error(
      "CODEX_AUTH_JSON_BASE64 is required when the Codex subscription experiment is enabled",
    );
  }
  const decoded = decodeBase64("CODEX_AUTH_JSON_BASE64", encoded);
  if (decoded.byteLength > 32 * 1024) {
    throw new Error("CODEX_AUTH_JSON_BASE64 exceeds the 32 KiB limit");
  }
  const authJson = decoded.toString("utf8");
  assertSubscriptionAuthJson(authJson);
  return authJson;
}

function encrypt(authJson: string, key: Buffer): EncryptedAuth {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(authJson, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(value: EncryptedAuth, key: Buffer): string {
  if (value.version !== 1)
    throw new Error("Unsupported encrypted Codex auth version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isLaneState(value: unknown): value is LaneState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    Boolean(state.auth) &&
    typeof state.seedDigest === "string"
  );
}

/**
 * A single, conservative ChatGPT-subscription lane. Unknown/stale ownership
 * never gets stolen automatically: the safe degradation is API billing.
 */
export class CodexSubscriptionLane {
  readonly enabled: boolean;
  /** True when the flag is explicitly true or false; absence is legacy mode. */
  readonly managed: boolean;
  private readonly key?: Buffer;
  private readonly seedAuth?: string;
  private readonly seedDigest?: string;

  constructor(
    private readonly metadata: MetadataStore,
    private readonly locks: LockStore,
    environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {
    const setting = environment.COMPADRE_CODEX_SUBSCRIPTION_EXPERIMENT_ENABLED;
    this.enabled = setting === "true";
    this.managed = setting === "true" || setting === "false";
    if (!this.enabled) return;
    this.key = encryptionKey(environment);
    this.seedAuth = subscriptionAuth(environment);
    this.seedDigest = createHash("sha256").update(this.seedAuth).digest("hex");
  }

  async claim(input: {
    canonicalThreadId: string;
    runId: string;
  }): Promise<CodexSubscriptionClaim> {
    if (!this.enabled) {
      return {
        route: "api",
        reason: this.managed ? "experiment_disabled" : "legacy_unmanaged",
        requiresConfiguration: this.managed,
      };
    }
    return this.locks.withLock(LOCK_KEY, async (signal) => {
      if (signal.aborted) throw signal.reason;
      const state = await this.readOrSeed();
      const existingRoute = state.routes?.[input.canonicalThreadId];
      if (existingRoute) {
        if (
          existingRoute.route === "subscription" &&
          state.owner?.canonicalThreadId !== input.canonicalThreadId
        ) {
          throw new Error("Inconsistent Codex subscription lane ownership");
        }
        await this.write({
          ...state,
          routes: {
            ...state.routes,
            [input.canonicalThreadId]: {
              ...existingRoute,
              runId: input.runId,
            },
          },
          ...(existingRoute.route === "subscription"
            ? { owner: { ...state.owner!, runId: input.runId } }
            : {}),
        });
        return {
          route: existingRoute.route,
          reason: "existing_route",
          ...(existingRoute.route === "subscription"
            ? { authJson: decrypt(state.auth, this.key!) }
            : {}),
          requiresConfiguration: false,
        };
      }
      if (state.owner?.canonicalThreadId === input.canonicalThreadId) {
        await this.write({
          ...state,
          owner: { ...state.owner, runId: input.runId },
          routes: {
            ...state.routes,
            [input.canonicalThreadId]: {
              route: "subscription",
              runId: input.runId,
              assignedAt: state.owner.claimedAt,
            },
          },
        });
        return {
          route: "subscription",
          reason: "owner_recovered",
          authJson: decrypt(state.auth, this.key!),
          requiresConfiguration: false,
        };
      }
      if (state.owner) {
        await this.write({
          ...state,
          routes: {
            ...state.routes,
            [input.canonicalThreadId]: {
              route: "api",
              runId: input.runId,
              assignedAt: this.now().toISOString(),
            },
          },
        });
        return {
          route: "api",
          reason: "lane_busy",
          requiresConfiguration: true,
        };
      }
      const claimed: LaneState = {
        ...state,
        owner: {
          canonicalThreadId: input.canonicalThreadId,
          runId: input.runId,
          claimedAt: this.now().toISOString(),
        },
        routes: {
          ...state.routes,
          [input.canonicalThreadId]: {
            route: "subscription",
            runId: input.runId,
            assignedAt: this.now().toISOString(),
          },
        },
      };
      await this.write(claimed);
      return {
        route: "subscription",
        reason: "lane_available",
        authJson: decrypt(claimed.auth, this.key!),
        requiresConfiguration: true,
      };
    });
  }

  async release(input: {
    canonicalThreadId: string;
    runId: string;
    refreshedAuthJson?: string;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    return this.locks.withLock(LOCK_KEY, async (signal) => {
      if (signal.aborted) throw signal.reason;
      const state = await this.readOrSeed();
      const route = state.routes?.[input.canonicalThreadId];
      if (!route || route.runId !== input.runId) return false;
      const routes = { ...state.routes };
      delete routes[input.canonicalThreadId];
      if (route.route === "api") {
        await this.write({ ...state, routes });
        return true;
      }
      if (
        state.owner?.canonicalThreadId !== input.canonicalThreadId ||
        state.owner.runId !== input.runId
      ) {
        return false;
      }
      if (!input.refreshedAuthJson) {
        throw new Error(
          "Refreshed subscription auth is required before release",
        );
      }
      assertSubscriptionAuthJson(input.refreshedAuthJson);
      await this.write({
        ...state,
        auth: encrypt(input.refreshedAuthJson, this.key!),
        owner: undefined,
        routes,
      });
      return true;
    });
  }

  async routeForThread(canonicalThreadId: string): Promise<CodexAuthRoute> {
    if (!this.enabled) return "api";
    const value = await this.metadata.get(NAMESPACE, STATE_KEY);
    return isLaneState(value)
      ? (value.routes?.[canonicalThreadId]?.route ?? "api")
      : "api";
  }

  async routeForRun(input: {
    canonicalThreadId: string;
    runId: string;
  }): Promise<CodexAuthRoute | undefined> {
    if (!this.enabled) return undefined;
    const value = await this.metadata.get(NAMESPACE, STATE_KEY);
    if (!isLaneState(value)) return undefined;
    const route = value.routes?.[input.canonicalThreadId];
    return route?.runId === input.runId ? route.route : undefined;
  }

  private async readOrSeed(): Promise<LaneState> {
    const value = await this.metadata.get(NAMESPACE, STATE_KEY);
    if (isLaneState(value)) {
      // A deliberate Render seed rotation replaces the persisted refresh chain
      // only while the lane is idle. Never change credentials under a process.
      if (!value.owner && value.seedDigest !== this.seedDigest) {
        const rotated: LaneState = {
          ...value,
          auth: encrypt(this.seedAuth!, this.key!),
          seedDigest: this.seedDigest!,
        };
        await this.write(rotated);
        return rotated;
      }
      return value;
    }
    const seeded: LaneState = {
      version: 1,
      auth: encrypt(this.seedAuth!, this.key!),
      seedDigest: this.seedDigest!,
    };
    await this.write(seeded);
    return seeded;
  }

  private write(state: LaneState): Promise<void> {
    return this.metadata.set(NAMESPACE, STATE_KEY, state);
  }
}
