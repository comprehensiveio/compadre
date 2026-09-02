# Observability

## Logging conventions

All application logging goes through `src/logging.ts` (`log` — a pino
logger). Never use `console.*` in new code: Node's console renders objects
with `util.inspect`, which hard-wraps into multiple lines, and Datadog
ingests each line as a separate orphan log with no level, service, env, or
trace correlation. pino emits one single-line JSON record per event, which
Datadog parses natively (level → status) and dd-trace enriches with
`dd.trace_id` / `dd.span_id` / `dd.service` / `dd.env` / `dd.version`
(`DD_LOGS_INJECTION` is defaulted on in `src/process-bootstrap.ts`).

Rules:

- `log.info({ ...fields }, "lowercase event description")` — fields first,
  message second. The message is a stable, greppable phrase; variable data
  goes in fields, never interpolated into the message.
- Always attach the correlation ids you have: `canonicalThreadId`, `runId`,
  `sandboxId`, `workerGeneration`, `slackChannelId`, `slackThreadTs`. For a
  whole unit of work, wrap it in `withLogContext({...}, fn)` and every log
  line inside inherits the ids.
- Never pass a raw `Error` as a field value (multi-line inspection). Spread
  `serializeError(error)` instead — it flattens name/message/stack/cause on
  one line and preserves structured fields of typed errors (e.g.
  `T3GatewayError`'s `kind`/`operation`/`status`/`code`).
- Errors that are thrown to a caller that logs them do not need logging at
  the throw site — but failure decisions (marking a worker lost, disabling
  Slack delivery, declaring a destination violation, timing out a turn) are
  logged where the decision is made, with the inputs to that decision
  (counters, deadlines, elapsed times).

## Datadog queries that now work

- All events for one thread: `@canonicalThreadId:<id>`
- One run end-to-end: `@runId:<id>` (joins driver, coordinator, Slack delivery)
- Sandbox lifecycle for one worker: `@sandboxId:sb-*`
- Deadline analysis: `message:"t3 turn wait timed out"` faceted by
  `@deadline` (absolute vs progress) and `@elapsedMs`
- Worker death spiral: `message:"native t3 watch interrupted; reattaching"`
  faceted by `@consecutiveUnavailable` and `@hasSnapshot` — a thread stuck on
  a dead sandbox shows `hasSnapshot:false` climbing to the max
- Destination check: `message:"protected slack destination*"` faceted by
  `@outcome` (`transient-read-failure` vs `destination-mismatch` vs
  `marker-missing`)

## Service tagging on Render

`render.yaml` sets `DD_ENV`/`DD_SERVICE` for the declared services.
Dashboard-created services (the `*-experiment` pair) do not inherit those:
`process-bootstrap` defaults `DD_ENV=experiment` and derives `DD_VERSION`
from `RENDER_GIT_COMMIT`, but set `DD_SERVICE` explicitly on each dashboard
service so logs stop inheriting instance hostnames as the service name.
