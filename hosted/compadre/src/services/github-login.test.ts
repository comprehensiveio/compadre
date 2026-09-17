import assert from "node:assert/strict";
import test from "node:test";
import { githubNoreplyEmail, normalizeGithubLogin } from "./github-login.js";

test("accepts usernames as typed, with a leading @, or pasted as a profile URL", () => {
  assert.equal(normalizeGithubLogin("imsherrill"), "imsherrill");
  assert.equal(normalizeGithubLogin("  @B-RadB "), "B-RadB");
  assert.equal(normalizeGithubLogin("https://github.com/octocat?tab=repositories"), "octocat");
  assert.equal(normalizeGithubLogin("github.com/bh2/"), "bh2");
});

test("rejects anything GitHub would not issue as a username", () => {
  assert.equal(normalizeGithubLogin(""), null);
  assert.equal(normalizeGithubLogin("-leading"), null);
  assert.equal(normalizeGithubLogin("double--hyphen"), null);
  assert.equal(normalizeGithubLogin("has space"), null);
  assert.equal(normalizeGithubLogin("a".repeat(40)), null);
  assert.equal(normalizeGithubLogin("isaac@example.com"), null);
  assert.equal(normalizeGithubLogin(undefined), null);
});

test("builds the noreply address GitHub links by username", () => {
  assert.equal(githubNoreplyEmail("imsherrill"), "imsherrill@users.noreply.github.com");
});
