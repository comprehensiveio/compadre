<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `npx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `npx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Monorepo context

This directory is the Compadre controller inside the `comprehensiveio/compadre`
monorepo. The repo root is the hosted T3 UI/server stack (pnpm + `vp`), which
this directory is deliberately independent of:

- This directory has its own npm toolchain: run `npm install`, `npm test`,
  `npm run typecheck`, etc. from `hosted/compadre/`. The root `vp` tooling and
  its fmt/lint/test checks do not apply here and exempt this path.
- CI lives at the repo root: `.github/workflows/compadre-ci.yml` (tests, path
  filtered to `hosted/compadre/**`) and
  `.github/workflows/compadre-monitor-hosted-stack.yml` (production probes).
- Merging `main` auto-deploys Render service `compadre-api` from this
  directory (Render root directory `hosted/compadre`); the root stack deploys
  separately as `compadre-web`. The two services never require an atomic
  rollout.
- The platform dev skills live at the repo root: `.agents/skills/`. The
  `skills/` directory *here* is different — runtime skills projected into
  Modal workers.

## Compadre stack changes

For any Compadre product, UI, agent-capability, protocol, database,
infrastructure, configuration, deployment, production-verification,
architecture, security, identity, runbook, or durable documentation change,
load and follow (path relative to the repo root):

`.agents/skills/change-compadre-stack/SKILL.md`

That skill routes work between this controller directory, the hosted T3 stack
at the repo root, Modal workers, Render services, Slack/API entrypoints, and
the Postgres/SQLite stores. Load only the reference files it selects for the
task.

If a change makes the skill verifiably inaccurate, update it in the same
change. For investigation of a specific failed or incomplete Slack-to-Modal
run, use `.agents/skills/debug-compadre-workflows/SKILL.md` instead; use both
only when the investigation leads to an implementation or deployment change.
