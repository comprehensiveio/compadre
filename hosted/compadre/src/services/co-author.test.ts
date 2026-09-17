import assert from "node:assert/strict";
import test from "node:test";
import {
  CO_AUTHOR_FILE,
  CO_AUTHOR_HOOK_PATH,
  CO_AUTHOR_HOOK_SCRIPT,
  buildCoAuthorInstallCommand,
  coAuthorTrailer,
  projectCoAuthor,
} from "./co-author.js";

test("prefers the real name and the verified email of the requester", () => {
  assert.equal(
    coAuthorTrailer({ displayName: "isaac", realName: "Isaac Sherrill", email: "isaac@example.com" }),
    "Co-authored-by: Isaac Sherrill <isaac@example.com>",
  );
  assert.equal(
    coAuthorTrailer({ displayName: "isaac", email: "isaac@example.com" }),
    "Co-authored-by: isaac <isaac@example.com>",
  );
});

test("prefers the GitHub noreply address when a username is stored, so GitHub links the account by login", () => {
  assert.equal(
    coAuthorTrailer({ displayName: "isaac", realName: "Isaac Sherrill", email: "isaac@example.com", githubLogin: "imsherrill" }),
    "Co-authored-by: Isaac Sherrill <imsherrill@users.noreply.github.com>",
  );
  assert.equal(
    coAuthorTrailer({ displayName: "isaac", githubLogin: "imsherrill" }),
    "Co-authored-by: isaac <imsherrill@users.noreply.github.com>",
  );
});

test("ignores a malformed stored username and falls back to the email", () => {
  assert.equal(
    coAuthorTrailer({ displayName: "isaac", email: "isaac@example.com", githubLogin: "bad login!" }),
    "Co-authored-by: isaac <isaac@example.com>",
  );
});

test("returns nothing without a usable address", () => {
  assert.equal(coAuthorTrailer({ displayName: "isaac" }), undefined);
  assert.equal(coAuthorTrailer({ displayName: "isaac", email: "not-an-email" }), undefined);
  assert.equal(coAuthorTrailer(null), undefined);
});

test("keeps the trailer on one line and free of angle brackets", () => {
  assert.equal(
    coAuthorTrailer({ displayName: "x", realName: "Eve <evil>\nCo-authored-by: other", email: "eve@example.com" }),
    "Co-authored-by: Eve evil Co-authored-by: other <eve@example.com>",
  );
});

test("the hook is a no-op without a trailer and never duplicates one", () => {
  assert.ok(CO_AUTHOR_HOOK_SCRIPT.startsWith("#!/bin/sh\n"));
  assert.ok(CO_AUTHOR_HOOK_SCRIPT.includes(`co_author_file="${CO_AUTHOR_FILE}"`));
  assert.ok(CO_AUTHOR_HOOK_SCRIPT.includes('[ -s "$co_author_file" ] || exit 0'));
  assert.ok(CO_AUTHOR_HOOK_SCRIPT.includes('git interpret-trailers --in-place --if-exists addIfDifferent --trailer "$trailer" "$1"'));
  assert.ok(buildCoAuthorInstallCommand("/workspace").includes("install -m 755"));
  assert.ok(buildCoAuthorInstallCommand("/workspace").includes("'/workspace/.git/hooks/prepare-commit-msg'"));
});

test("projects the hook and trailer into the worker and clears a previous requester", async () => {
  const writes: Array<[string, string]> = [];
  const commands: string[] = [];
  const sandbox = {
    fs: { write: async (path: string, contents: string) => { writes.push([path, contents]); } },
    process: { exec: async (command: string) => { commands.push(command); return { exitCode: 0, stdout: "", stderr: "" }; } },
  };
  const trailer = "Co-authored-by: Isaac Sherrill <imsherrill@users.noreply.github.com>";
  await projectCoAuthor(sandbox, "/workspace", trailer);
  assert.deepEqual(writes, [[CO_AUTHOR_HOOK_PATH, CO_AUTHOR_HOOK_SCRIPT], [CO_AUTHOR_FILE, `${trailer}\n`]]);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => !command.includes("imsherrill")));

  writes.length = 0;
  await projectCoAuthor(sandbox, "/workspace", undefined);
  assert.deepEqual(writes[1], [CO_AUTHOR_FILE, ""]);
});
