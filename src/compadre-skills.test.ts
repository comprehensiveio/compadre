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
