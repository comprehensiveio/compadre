# Triggered prompts

Stored prompts fired by a trigger — cron schedules today, other sources later.
Definitions live in Compadre Postgres (`compadre_triggered_prompts`); each row
is mirrored to one Temporal Schedule (`triggered-prompt-<id>`) that starts
`triggeredPromptWorkflow` on the `compadre-native-t3` task queue. The workflow
re-reads the row (so edits apply without resync) and hands the prompt to the
delivery layer (`src/triggers/deliver.ts`):

1. The turn is dispatched straight to central T3 with `origin: "trigger"`
   message attribution carrying `{ triggerId, name, triggerType,
   cronExpression, timezone? }`. The Compadre web UI renders this in place of
   a user (alarm icon + trigger name, schedule on hover). The prompt itself is
   **never posted to Slack** — only the agent's answer is. Trigger turns are
   deliberately excluded from the native "From Compadre web" Slack mirror and
   from the trusted-requester prompt context
   (`src/routes/t3-directory.ts`), so the agent sees the prompt verbatim and
   the mirror cannot leak it.
2. Answer delivery: `new_thread` posts the answer as a fresh Slack root;
   `same_thread` uses a stable per-trigger conversation key
   (`trigger:<id>`) so every fire continues one central thread, with the
   first answer's Slack root (recorded as a hosted thread binding) anchoring
   where later answers reply. `existing_thread` targets a central T3 thread
   id: Slack-linked threads get the answer as a thread reply, web-only
   threads get nothing in Slack. Answer posting is fire-and-forget beyond
   dispatch — failures log and post one failure notice to the known Slack
   thread; in-flight posts are drained on controller shutdown.
3. The agent receives the prompt text verbatim — trigger metadata never
   enters agent context.

Provenance is per message: a thread can interleave human turns and triggered
turns in the web UI.

## Surfaces

- Management UI: Compadre web → Settings → Triggered Prompts (root stack),
  which proxies same-origin to the controller
  (`apps/server/src/auth/CompadreTriggeredPrompts.ts`); the service key never
  reaches the browser and `createdBy` is stamped from the session user.
- Controller API: `/triggers/api/prompts[...]` on the controller,
  bearer-authenticated with `COMPADRE_API_KEY` (the same service key the
  central server holds for the operations page).
- Manual fire: `POST /triggers/api/prompts/:id/run` starts the same workflow
  the schedule would.

## Configuration

- No dedicated flag: the routes ship with the hosted directory surface
  (`COMPADRE_T3_DIRECTORY_ENABLED`); with no stored definitions the feature is
  inert. Delivery requires the central T3 client configuration
  (`COMPADRE_T3_CENTRAL_URL`/`COMPADRE_T3_CENTRAL_TOKEN`) and, for Slack
  posting, `SLACK_BOT_TOKEN` plus `COMPADRE_SLACK_WORKSPACE_ID`.
- Schedules are reconciled with Postgres at controller startup (missing ones
  created, orphans deleted); failures are logged, never fatal. Creating a
  prompt whose schedule cannot be created rolls the row back.

## Deploy notes

- Central T3 (`compadre-web`) must accept the `"trigger"` message origin
  (contracts change) before a trigger fires. Both halves land in one merge;
  since no trigger can exist until the settings UI ships, the rollout order
  is safe in practice.
- The `compadre_triggered_prompts` migration runs through the standard
  pre-deploy `npm run db:migrate`.
