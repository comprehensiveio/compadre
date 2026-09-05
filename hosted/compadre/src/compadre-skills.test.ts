import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPADRE_SKILL_NAMES,
  compadreSkillUploads,
  sandboxCompadreSkillPath,
} from "./compadre-skills.js";

test("loads each provider-neutral skill from the Compadre checkout", () => {
  const uploads = compadreSkillUploads();
  assert.equal(uploads.length, COMPADRE_SKILL_NAMES.length);
  for (const upload of uploads) {
    assert.match(upload.path, /^\/opt\/compadre-skills\/.+\/SKILL\.md$/);
    assert.match(Buffer.from(upload.data).toString("utf8"), /^---\nname:/);
  }
});

test("builds sandbox-local skill paths", () => {
  assert.equal(
    sandboxCompadreSkillPath("query-database"),
    "/opt/compadre-skills/query-database/SKILL.md",
  );
});

test("pins dev-environment browser validation to the image Chromium", () => {
  const skill = compadreSkillUploads().find((upload) =>
    upload.path.endsWith("/dev-environment/SKILL.md"),
  );
  assert.ok(skill);
  assert.match(
    Buffer.from(skill.data).toString("utf8"),
    /AGENT_BROWSER_EXECUTABLE_PATH=\/usr\/bin\/chromium/,
  );
});

test("teaches agents to hand users a contextual dev-login URL", () => {
  const skill = compadreSkillUploads().find((upload) =>
    upload.path.endsWith("/dev-environment/SKILL.md"),
  );
  assert.ok(skill);
  const contents = Buffer.from(skill.data).toString("utf8");

  assert.match(contents, /proactively include a complete Comp dev-login/);
  assert.match(contents, /\/api\/v1\/auth\/dev\/login\/user\?userId=<uuid>/);
  assert.match(contents, /best demonstrate the functionality the thread is about/);
  assert.match(contents, /does not imply that an admin is always the best reviewer/);
  assert.match(contents, /company ID `9`/);
  assert.match(contents, /company=9&redirect=%2F/);
  assert.match(
    contents,
    /Links\s+using `auto_impersonate` are not valid review links/,
  );
});
