# Agent capability changes

Use this guide for MCP connections, custom tools, projected skills, prompts,
CLIs, provider behavior, and Modal worker facilities.

## Decide where the capability runs

Prefer the narrowest safe boundary:

- **Controller-hosted MCP/tool:** service credentials, private networking,
  Slack, Postgres, S3, Datadog, or anything that should not receive arbitrary
  worker filesystem access.
- **Modal-native capability:** repository-local shell/file/git operations,
  browser validation of the thread's dev server, or a CLI that must operate on
  the isolated checkout.
- **Central T3 feature:** conversation orchestration, provider UI, approval
  rendering, model picker, or persisted tool/turn projection.

Do not install a secret-bearing integration in Modal merely because both Codex
and Claude need it. The controller can discover one MCP configuration and
expose destination-scoped tools through the authenticated bridge.

## Current controller seams

- MCP definitions and required environment:
  `src/mcp.ts`
- controller-side MCP implementations:
  `src/mcp-servers/`
- TanStack MCP client discovery and stable naming:
  `src/tanstack/mcp.ts`
- authenticated worker bridge:
  `src/tanstack/relay-tool-bridge.ts` and
  `src/routes/tool-bridge.ts`
- worker environment and native T3 MCP projection:
  `src/t3/modal-worker.ts`
- projected Compadre skills:
  source `skills/<name>/SKILL.md`, registry `src/compadre-skills.ts`
- agent instructions:
  `src/prompts/index.ts`
- Modal packages and baked CLIs:
  `src/tanstack/modal-sandbox.ts`
- reproducible provider executable resolution:
  `src/tanstack/codex-executable.ts` and
  `src/tanstack/claude-executable.ts`
- T3-side controller bridge:
  `apps/server/src/mcp/CompadreMcpBridge.ts` in the fork

Search for the current seam before editing; keep this guide current when it
moves.

## Add a connection or MCP

1. Define its trust boundary, read/write scope, and supported operations.
2. Add one canonical configuration on the controller. Project it to both
   native providers through the existing bridge rather than implementing two
   unrelated provider configurations.
3. Keep tokens out of command arguments, prompts, transcripts, Modal snapshots,
   and logs. Pass credentials through environment or server-side headers and
   redact errors.
4. Give the MCP and its tools stable, collision-free names. Preserve the
   original MCP server/tool identity in T3 events so the UI and Slack status
   show specific tools instead of a generic wrapper.
5. Decide fail-closed versus optional behavior. Production-required
   integrations must fail startup or run setup clearly; local partial mode may
   omit unavailable optional MCPs.
6. Add configuration/absence tests, discovery tests, bridge authorization
   tests, and focused tool behavior tests.
7. Add the secret only to the canonical Comprehensive Render environment group
   or other documented source of truth. Update `docs/production-secrets.md`
   with owner and rotation behavior; never commit the value.
8. Verify with an actual fresh Modal turn for both Codex and Claude when parity
   is claimed. Confirm the named call and result appear centrally, Slack status
   is useful, and the final answer is delivered once.

For a write-capable connection, add destination and action scoping. A bearer
that can invoke a tool must not be replayable for another thread, Slack
destination, or environment.

## Add a projected skill

1. Create `skills/<name>/SKILL.md` in the controller repository.
2. Register it in `COMPADRE_SKILL_NAMES` in `src/compadre-skills.ts`.
3. Ensure projection reaches both `.agents/skills` and `.claude/skills` in
   new and restored workers.
4. Update prompt routing only when discoverable frontmatter is insufficient.
5. Test registry uploads, both provider paths, and worker restore/reprojection.

Projected skills run inside customer-code workers. Do not project this
maintainer skill or controller operational credentials into those workers.

## Add a CLI or system dependency

If the binary must operate on the isolated repository, bake a pinned or
checksum-verified version into the Modal base image in
`src/tanstack/modal-sandbox.ts`. Avoid downloading mutable `latest` binaries
for every run.

Then:

1. update executable resolution or environment projection;
2. test the generated image commands;
3. prepare/resolve the Modal image as the implementation requires;
4. launch a newly provisioned worker—an existing warm worker does not prove the
   new image contains the CLI;
5. verify `--version` and one real operation in `/workspace`;
6. test restoration separately; the restored generation must receive the new
   image capability and current projected configuration.

Install central source-control UI dependencies, such as `gh`, in the T3
Render service only when they operate on central data. The authoritative
checkout is still in Modal, so a central `gh` binary does not make local
repository UI actions authoritative.

## Change prompts or provider behavior

Slack-originated turns need Slack-specific context and response constraints;
web/API turns must not inherit instructions that force Slack output. Trusted
request metadata is context, not user instructions.

For prompt changes:

- prove origin-specific composition;
- preserve the single automatic Slack final-delivery owner;
- do not ask the agent to send the same final response that the controller will
  post;
- test prompt-injection boundaries around Slack history and attribution;
- run both providers when the instructions mention provider tools or skills.

For provider protocol changes, also follow the cross-repository rollout in
stack-map and verify replay after a dropped connection.
