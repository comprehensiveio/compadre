import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";

import {
  buildClaudeMcpServers,
  buildCodexMcpLaunchConfig,
  readCompadreMcpBridge,
} from "./CompadreMcpBridge.ts";

const nativeSession = {
  endpoint: "http://127.0.0.1:3773/api/mcp/native",
  authorizationHeader: "Bearer native-token",
};
const compadreBridge = {
  endpoint: "https://compadre.example/internal/mcp",
  authorizationHeader: "Bearer compadre-token",
};

describe("CompadreMcpBridge", () => {
  it("requires its URL and token together", () => {
    assert.equal(readCompadreMcpBridge({}), undefined);
    assert.throws(
      () => readCompadreMcpBridge({ COMPADRE_MCP_URL: compadreBridge.endpoint }),
      /must be configured together/,
    );
    assert.throws(
      () =>
        readCompadreMcpBridge({
          COMPADRE_MCP_URL: "file:///tmp/mcp",
          COMPADRE_MCP_BEARER_TOKEN: "token",
        }),
      /HTTP or HTTPS/,
    );
  });

  it("injects the same authenticated bridge into Claude and Codex", () => {
    assert.deepEqual(buildClaudeMcpServers(nativeSession, compadreBridge), {
      "t3-code": {
        type: "http",
        url: nativeSession.endpoint,
        headers: { Authorization: "Bearer native-token" },
      },
      compadre: {
        type: "http",
        url: compadreBridge.endpoint,
        headers: { Authorization: "Bearer compadre-token" },
      },
    });
    assert.deepEqual(buildCodexMcpLaunchConfig(nativeSession, compadreBridge), {
      environment: {
        T3_MCP_BEARER_TOKEN: "native-token",
        COMPADRE_MCP_BEARER_TOKEN: "compadre-token",
      },
      appServerArgs: [
        "-c",
        `mcp_servers.t3-code.url=${nativeSession.endpoint}`,
        "-c",
        'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
        "-c",
        `mcp_servers.compadre.url=${compadreBridge.endpoint}`,
        "-c",
        'mcp_servers.compadre.bearer_token_env_var="COMPADRE_MCP_BEARER_TOKEN"',
      ],
    });
  });

  it("omits adapter MCP options when neither server is configured", () => {
    assert.equal(buildClaudeMcpServers(undefined, undefined), undefined);
    assert.equal(buildCodexMcpLaunchConfig(undefined, undefined), undefined);
  });
});
