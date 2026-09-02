# Compadre

Comprehensive's internal monorepo for **Compadre**: agents your team drives
from Slack, the browser, or an HTTP API, executing in isolated per-thread
Modal environments with one shared, durable conversation.

This repository contains two layers:

- **Repo root** — the hosted UI/server stack: a divergent fork of
  [T3 Code](https://github.com/pingdotgg/t3code) serving the Compadre web app
  (`compadre.comprehensive.io`) and central conversation store. pnpm + `vp`
  toolchain. Deploys as Render service `compadre-web`.
- **[`hosted/compadre/`](./hosted/compadre)** — the Compadre controller:
  Slack/API ingress, durable run orchestration (Temporal), the Postgres
  control plane, and per-thread Modal worker fanout
  (`compadre-api.comprehensive.io`). Independent npm toolchain. Deploys as
  Render service `compadre-api`.

## Working here

- Agent and contributor guidance starts at [`AGENTS.md`](./AGENTS.md); the
  controller has its own [`hosted/compadre/AGENTS.md`](./hosted/compadre/AGENTS.md).
- Cross-stack changes are routed by
  [`.agents/skills/change-compadre-stack/SKILL.md`](./.agents/skills/change-compadre-stack/SKILL.md).
- Root stack: install `vp` (`curl -fsSL https://vite.plus | bash`), then `vp i`
  and `vp run dev`. Internals docs start at
  [docs/internals/overview.md](./docs/internals/overview.md).
- Controller: `npm install` and the npm scripts in
  [`hosted/compadre/package.json`](./hosted/compadre/package.json); docs under
  [`hosted/compadre/docs/`](./hosted/compadre/docs).
- CI: the root stack's `ci.yml` plus `compadre-ci.yml` (path-filtered to
  `hosted/compadre/**`) and `compadre-monitor-hosted-stack.yml` (production
  probes), all in [`.github/workflows/`](./.github/workflows).
- Deploys: merging `main` auto-deploys the touched services on Render;
  [`render.yaml`](./render.yaml) at the root describes the stack.

## Upstream heritage

The root stack forks `pingdotgg/t3code` (kept as the `upstream` remote).
Upstream is a merge source only — sync with a plain `git merge upstream/main`;
`hosted/` is never touched by upstream. Our divergence from upstream is
deliberate; see [docs/internals/compadre-fork.md](./docs/internals/compadre-fork.md)
for the fork seams and merge discipline. History before the monorepo merge
lives across the original T3 Code fork history and the imported
`hosted/compadre` history (formerly `comprehensiveio/compadre`, now archived
as `compadre-archive`).
