// Rendered product regression check; no Modal worker or Slack request is made.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assertLocalStack } from "./config.mjs";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const dir = process.argv[2];
if (!dir)
  throw new Error(
    "Usage: node scripts/compadre-e2e/check-sidebar.mjs /state/directory [browser-session]",
  );
const config = JSON.parse(NodeFS.readFileSync(NodePath.resolve(dir, "private.json"), "utf8"));
assertLocalStack(config);
const session = process.argv[3] ?? "compadre-sidebar-ui";
const require = NodeModule.createRequire(NodePath.resolve(root, "hosted/compadre/package.json"));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: config.controller.COMPADRE_DURABILITY_DATABASE_URL });
const fixtureId = "1025f03f-f910-48ab-8c68-c8eaa021da4b";
const fixtureTitle = "Sidebar UI fixture";
const slackUrl = "https://example.slack.com/archives/C_SIDEBAR_FIXTURE/p1234567890";
const avatarUrl =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="16" fill="#315844"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="18">A</text></svg>',
  );

function browser(...args) {
  // Suppress command arguments in failures: login navigation contains a one-time grant.
  try {
    const output = NodeChildProcess.execFileSync(
      "agent-browser",
      ["--session", session, "--json", ...args],
      {
        encoding: "utf8",
        timeout: 45000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(output);
    NodeAssert.equal(result.success, true, result.error ?? "Browser action failed");
    return result.data;
  } catch {
    throw new Error(`Sidebar browser action failed: ${args[0]}`);
  }
}
function evaluate(source) {
  return browser("eval", source).result;
}
function waitFor(source) {
  browser("wait", "--fn", source);
}

try {
  // This is a disposable read-model fixture, not a simulated Slack ingress test.
  const {
    rows: [source],
  } = await pool.query(
    `SELECT * FROM compadre_t3.projection_threads
    WHERE deleted_at IS NULL AND thread_id <> $1 AND participants_json <> '[]'
    ORDER BY updated_at DESC LIMIT 1`,
    [fixtureId],
  );
  NodeAssert.ok(source, "Complete a hosted E2E turn before running the sidebar check");
  const participants = JSON.parse(source.participants_json);
  participants[0].avatarUrl = avatarUrl;
  const fixture = {
    ...source,
    thread_id: fixtureId,
    title: fixtureTitle,
    participants_json: JSON.stringify(participants),
    external_thread_json: JSON.stringify({ provider: "slack", url: slackUrl }),
    archived_at: null,
    settled_at: null,
    settled_override: null,
    snoozed_until: null,
    latest_turn_id: null,
    updated_at: new Date().toISOString(),
  };
  await pool.query("DELETE FROM compadre_t3.projection_threads WHERE thread_id = $1", [fixtureId]);
  await pool.query(
    "INSERT INTO compadre_t3.projection_threads SELECT * FROM jsonb_populate_record(NULL::compadre_t3.projection_threads, $1::jsonb)",
    [JSON.stringify(fixture)],
  );

  const login = NodeChildProcess.execFileSync(
    process.execPath,
    ["scripts/compadre-e2e.mjs", "login", "--state", dir, "--user", "alice"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .trim()
    .split("\n")
    .at(-1);
  NodeAssert.equal(new URL(login).origin, config.webUrl);
  browser("--headed", "open", login);
  browser("set", "viewport", "1280", "900");
  waitFor('!!document.querySelector("[aria-label=\\"Filter conversations\\"]")');
  const sidebar = '[data-sidebar="sidebar"]';
  const filter = '[aria-label="Filter conversations"]';
  const readChrome = `(() => {
    const sidebar = document.querySelector(${JSON.stringify(sidebar)});
    const group = sidebar.querySelector(${JSON.stringify(filter)});
    const search = sidebar.querySelector('[aria-label="Search threads"]');
    const brand = sidebar.querySelector('[aria-label="Go to threads"]');
    return {
      filters: [...group.querySelectorAll('button')].map(b => b.textContent),
      pressed: [...group.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent),
      logo: brand.querySelector('img')?.getAttribute('src'),
      brand: brand.textContent,
      headerOrder: brand.getBoundingClientRect().bottom <= group.getBoundingClientRect().top && group.getBoundingClientRect().bottom <= search.getBoundingClientRect().top,
      searchWidth: search.getBoundingClientRect().width,
      projectControls: !!sidebar.querySelector('[aria-label="New project"], [aria-label="Filter threads by project"]'),
      operations: !!sidebar.querySelector('[aria-label="Thread environments"]'),
      newThread: !!sidebar.querySelector('[aria-label="New thread"]'),
    };
  })()`;
  const chrome = evaluate(readChrome);
  NodeAssert.deepEqual(chrome.filters, ["With me", "Started by me", "All"]);
  NodeAssert.deepEqual(chrome.pressed, ["With me"]);
  NodeAssert.equal(chrome.logo, "/compadre.png");
  NodeAssert.match(chrome.brand, /Compadre/);
  NodeAssert.equal(
    chrome.headerOrder,
    true,
    "Brand, identity tabs and search must remain separate ordered rows",
  );
  NodeAssert.ok(chrome.searchWidth > 80, "Search must remain usable");
  NodeAssert.equal(chrome.projectControls, false);
  NodeAssert.equal(chrome.operations, true);
  NodeAssert.equal(chrome.newThread, true);
  for (const name of ["Started by me", "All", "With me", "All"]) {
    browser("find", "role", "button", "click", "--name", name, "--exact");
    NodeAssert.deepEqual(evaluate(readChrome).pressed, [name]);
  }
  waitFor(`!!document.querySelector('a[href="${slackUrl}"]')`);
  const row = evaluate(`(() => {
    const link = document.querySelector('a[href="${slackUrl}"]');
    const row = link.closest('li');
    return { label: link.getAttribute('aria-label'), target: link.target,
      photo: [...row.querySelectorAll('[aria-label^="Participants:"] img')].some(img => img.complete && img.naturalWidth > 0),
      title: row.textContent };
  })()`);
  NodeAssert.equal(row.label, "Open Slack thread");
  NodeAssert.equal(row.target, "_blank");
  NodeAssert.equal(row.photo, true, "Participant photo must actually load in the thread row");
  NodeAssert.match(row.title, /Sidebar UI fixture/);
  browser("fill", '[aria-label="Search threads"]', fixtureTitle);
  waitFor('!!document.querySelector("[aria-label=\\"Clear thread search\\"]")');
  browser("click", '[aria-label="Clear thread search"]');
  NodeAssert.equal(
    evaluate('document.querySelector("[aria-label=\\"Search threads\\"]").value'),
    "",
  );
  browser("click", '[aria-label="Thread environments"]');
  waitFor('location.pathname === "/operations/threads"');
  waitFor('document.querySelector("h1")?.textContent === "Thread environments"');
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  waitFor('!!document.querySelector("[aria-label=\\"Filter conversations\\"]")');
  browser("reload");
  waitFor('!!document.querySelector("[aria-label=\\"Thread environments\\"]")');
  NodeAssert.equal(evaluate(readChrome).operations, true);
  browser("find", "role", "button", "click", "--name", "All", "--exact");
  waitFor(`!!document.querySelector('a[href="${slackUrl}"]')`);
  console.log(
    "PASS: hosted brand/layout, identity tabs, search, new thread, participant photo, Slack link, operations navigation/back and reload.",
  );
  console.log(
    "The headed browser and clearly labeled disposable UI fixture are retained for review.",
  );
} finally {
  await pool.end();
}
