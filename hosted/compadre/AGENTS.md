<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `npx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `npx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Compadre stack changes

For any Compadre product, UI, agent-capability, protocol, database,
infrastructure, configuration, deployment, production-verification,
architecture, security, identity, runbook, or durable documentation change,
load and follow:

`.agents/skills/change-compadre-stack/SKILL.md`

That skill routes work between the controller repository, the hosted T3 fork,
Modal workers, Render services, Slack/API entrypoints, and the Postgres/SQLite
stores. Load only the reference files it selects for the task.

If a change makes the skill verifiably inaccurate, update it in the same
change. For investigation of a specific failed or incomplete Slack-to-Modal
run, use `.agents/skills/debug-compadre-workflows/SKILL.md` instead; use both
only when the investigation leads to an implementation or deployment change.
