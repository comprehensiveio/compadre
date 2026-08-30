import assert from "node:assert/strict";
import test from "node:test";
import {
  COMP_DEV_SERVER_PORT,
  devEnvironmentArtifactProjection,
  t3EncryptedPorts,
  T3_SERVER_PORT,
} from "./dev-environment.js";

test("keeps development resources disabled for ordinary thread sandboxes", async () => {
  assert.deepEqual(t3EncryptedPorts({}), [T3_SERVER_PORT]);
  assert.deepEqual(await devEnvironmentArtifactProjection({}), {});
});

test("projects scoped, expiring Comprehensive artifact URLs for enabled threads", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const projection = await devEnvironmentArtifactProjection(
    {
      COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
      COMPADRE_DEV_ARTIFACT_BUCKET: "compadre-test",
      COMPADRE_DEV_ARTIFACT_PREFIX: "/dev/comp/",
      COMPADRE_DEV_ARTIFACT_REGION: "us-west-2",
      COMPADRE_DEV_ARTIFACT_URL_TTL_SECONDS: "3600",
    },
    {
      sign: async (input) => {
        requests.push(input);
        return `https://signed.test/${input.key}`;
      },
    },
  );

  assert.deepEqual(t3EncryptedPorts({ COMPADRE_DEV_ENVIRONMENT_ENABLED: "true" }), [
    T3_SERVER_PORT,
    COMP_DEV_SERVER_PORT,
  ]);
  assert.deepEqual(Object.keys(projection).sort(), [
    "PGDATA_URL",
    "PREBUILT_URL",
    "SEED_URL",
    "VITE_CACHE_URL",
  ]);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0], {
    bucket: "compadre-test",
    key: "dev/comp/seed-latest.tar",
    region: "us-west-2",
    expiresIn: 3600,
  });
});

test("rejects artifact credentials outside the supported lifetime", async () => {
  await assert.rejects(
    devEnvironmentArtifactProjection({
      COMPADRE_DEV_ENVIRONMENT_ENABLED: "true",
      COMPADRE_DEV_ARTIFACT_URL_TTL_SECONDS: "900000",
    }),
    /integer from 60 to 604800/,
  );
});
