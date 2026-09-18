import * as NodeTest from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import {
  assertDevelopmentDopplerConfig,
  assertLocalStack,
  centralGitHubCredentials,
  developmentCredentials,
  issuedToken,
} from "./config.mjs";
const credentials = {
  MODAL_TOKEN_ID: "id",
  MODAL_TOKEN_SECRET: "secret",
  ANTHROPIC_API_KEY: "provider",
};
NodeTest.test("does not inherit production destinations or unrelated service credentials", () => {
  NodeAssert.deepEqual(
    developmentCredentials(
      {
        ...credentials,
        SLACK_BOT_TOKEN: "slack",
        DATABASE_URL: "postgres://production",
        COMPADRE_PUBLIC_URL: "https://production",
      },
      { AWS_SECRET_ACCESS_KEY: "aws", DD_API_KEY: "telemetry" },
    ),
    credentials,
  );
});
NodeTest.test("reports missing keys without exposing values", () => {
  NodeAssert.throws(() => developmentCredentials({ MODAL_TOKEN_ID: "sensitive" }), {
    message: "Missing MODAL_TOKEN_SECRET",
  });
});
NodeTest.test("accepts only the Compadre development Doppler environment", () => {
  assertDevelopmentDopplerConfig({
    DOPPLER_PROJECT: "compadre",
    DOPPLER_ENVIRONMENT: "dev",
    DOPPLER_CONFIG: "dev_personal",
  });
  NodeAssert.throws(
    () =>
      assertDevelopmentDopplerConfig({
        DOPPLER_PROJECT: "compadre",
        DOPPLER_ENVIRONMENT: "prd",
        DOPPLER_CONFIG: "prd",
      }),
    { message: /Compadre development Doppler config/ },
  );
});
NodeTest.test("maps one canonical GitHub credential to central T3's required name", () => {
  NodeAssert.deepEqual(centralGitHubCredentials({ GITHUB_PERSONAL_ACCESS_TOKEN: "github-token" }), {
    GH_TOKEN: "github-token",
  });
  NodeAssert.deepEqual(centralGitHubCredentials({}), {});
});
NodeTest.test("refuses remote databases when loading a saved stack", () => {
  NodeAssert.throws(() =>
    assertLocalStack({
      controller: { COMPADRE_DURABILITY_DATABASE_URL: "postgres://production/compadre_e2e_test" },
    }),
  );
});
NodeTest.test("accepts the isolated local topology", () => {
  assertLocalStack({
    controller: {
      COMPADRE_DURABILITY_DATABASE_URL: "postgres://127.0.0.1:1234/compadre_e2e_test",
      COMPADRE_T3_MODAL_APP: "compadre-e2e-example",
    },
    webUrl: "http://localhost:6600",
  });
});

NodeTest.test("never treats diagnostic output as part of a bearer token", () => {
  NodeAssert.equal(issuedToken("  payload.signature\n"), "payload.signature");
  NodeAssert.throws(() => issuedToken("warning: private-details\npayload.signature"), {
    message: "Central token issuance returned unexpected output; inspect its private log",
  });
});
