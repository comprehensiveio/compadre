# Contributing

This is Comprehensive's internal monorepo for Compadre. It is not the place
for external contributions.

- **External contributors:** this repository's root stack is a divergent fork
  of [T3 Code](https://github.com/pingdotgg/t3code). If you want to contribute
  to T3 Code itself, do so upstream — read
  [upstream's CONTRIBUTING.md](https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md)
  and their [Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
  PRs opened here that target upstream behavior will be closed.
- **Comprehensive team:** follow [`AGENTS.md`](./AGENTS.md) and route Compadre
  platform work through
  [`.agents/skills/change-compadre-stack/SKILL.md`](./.agents/skills/change-compadre-stack/SKILL.md).
  Keep PRs to one concern, conventional commit titles, evidence uploaded to
  GitHub (never committed), and never merge without the checks that apply to
  the paths you touched.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*`
diff size based on changed lines.
