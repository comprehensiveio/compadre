const TOKEN_ENDPOINT =
  "https://mcp.datadoghq.com/api/unstable/mcp-server/token";

// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let currentAccessToken: string | null = null;
let expiresAt = 0;
let currentRefreshToken: string | null = null;
let clientId: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<string> | null = null;
let disabledReason: string | null = null;

export function initDatadogAuth(opts: {
  clientId: string;
  refreshToken: string;
}) {
  clientId = opts.clientId;
  currentRefreshToken = opts.refreshToken;
  disabledReason = null;
}

export function isDatadogAuthConfigured(): boolean {
  return Boolean(clientId && currentRefreshToken && !disabledReason);
}

export function getDatadogAuthDisabledReason(): string | null {
  return disabledReason;
}

export async function getDatadogAccessToken(): Promise<string> {
  if (disabledReason) {
    throw new Error(`Datadog auth is disabled: ${disabledReason}`);
  }
  if (!clientId || !currentRefreshToken) {
    throw new Error(
      "Datadog MCP credentials are not configured; set DATADOG_MCP_CLIENT_ID and DATADOG_MCP_REFRESH_TOKEN"
    );
  }
  if (currentAccessToken && Date.now() < expiresAt - REFRESH_BUFFER_MS) {
    return currentAccessToken;
  }
  return refreshAccessToken();
}

async function refreshAccessToken(): Promise<string> {
  // If a refresh is already in-flight, return the same promise
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefreshAccessToken().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefreshAccessToken(): Promise<string> {
  if (!clientId || !currentRefreshToken) {
    throw new Error(
      "Datadog MCP credentials are not configured; set DATADOG_MCP_CLIENT_ID and DATADOG_MCP_REFRESH_TOKEN"
    );
  }

  const configuredClientId = clientId;
  const configuredRefreshToken = currentRefreshToken;

  console.log("[datadog] refreshing access token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: configuredRefreshToken,
    client_id: configuredClientId,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes("invalid_grant")) {
      disabledReason =
        "Datadog refresh token is invalid or expired; update DATADOG_MCP_REFRESH_TOKEN and restart";
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }
    throw new Error(`Datadog token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  currentAccessToken = data.access_token;
  expiresAt = Date.now() + data.expires_in * 1000;

  // Some OAuth servers rotate refresh tokens
  if (data.refresh_token) {
    currentRefreshToken = data.refresh_token;
  }

  console.log(
    `[datadog] token refreshed, expires in ${Math.round(data.expires_in / 60)}m`
  );

  scheduleNextRefresh(data.expires_in);

  return currentAccessToken;
}

function scheduleNextRefresh(expiresInSeconds: number) {
  if (refreshTimer) clearTimeout(refreshTimer);

  const refreshInMs = (expiresInSeconds * 1000) - REFRESH_BUFFER_MS;
  if (refreshInMs > 0) {
    refreshTimer = setTimeout(() => {
      refreshAccessToken().catch((err) =>
        console.error("[datadog] auto-refresh failed:", err)
      );
    }, refreshInMs);
  }
}
