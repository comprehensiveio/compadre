# Measuring hosted preview requests

The central preview gateway emits one JSON `compadre.preview.request` log for
an authenticated HTTP request with a resolved worker. Group by `requestKind`
(`document`, `module`, `api`, `other`) and `method`, and correlate by
`canonicalThreadId`. API includes `/api/` and TanStack `/_serverFn/`; module
classification includes Vite internal and node_modules paths. These records do
not contain resource paths, query strings, headers, or request bodies.

- `authMs`: central session verification and requester resolution.
- `resolveMs`: worker target resolution, including controller lookup on cache misses.
- `proxyHeadersMs`: proxy processing until upstream response headers arrive.
  Includes request-body buffering for writes and the network hop to Modal.
  It does not isolate Vite transformation, application work, or worker CPU.
- `headersMs`: total of those phases; **not** the streamed response-body duration.
- `status` and `proxyFailed`: distinguish upstream status from a proxy failure
  that may return a 200 startup interstitial.

WebSocket lifetimes, telemetry endpoints, and requests that return an activation
page before a worker is resolved are excluded. These measurements do not wake
workers or change their lifetime. `COMPADRE_PREVIEW_TELEMETRY_ENABLED=false`
disables request timing logs, gateway Server-Timing headers, and browser telemetry.

The same phase durations appear in `Server-Timing` as `compadre_auth`,
`compadre_resolve`, and `compadre_proxy`; upstream timing entries are preserved.
The injected browser collector aggregates them into `requests.document`,
`requests.module`, `requests.api`, and `requests.other` on existing
`compadre.preview.browser` reports. Each group has counts and cumulative
`durationMs`, `preRequestMs`, `waitMs`, `transferMs`, `authMs`, `resolveMs`, and
`proxyHeadersMs`. `gatewayCount` counts entries with gateway timings; absence
is not evidence of a zero-duration gateway. Browser cache entries may retain
headers from an earlier response, so use the server logs for fresh gateway work.

Browser pre-request time spans resource start to request start (including
queueing, DNS and connection setup); wait spans request start to first response
byte; transfer spans first to last response byte. Unavailable zero timestamps
are excluded from these three sums. Document timing is taken from the navigation
entry; completed resources come from PerformanceObserver, including pending
records drained before a report. In-flight or aborted requests can be absent.

These sums overlap across concurrent requests and are **not additive page-load
phases or a critical-path trace**. Compare counts and distributions alongside
`app_ready.elapsedMs`. Large proxy waits call for worker/network investigation;
large browser transfer or pre-request intervals point to a different part of the
path. `longTaskCount`, `longTaskMs`, and `longTasksSupported` distinguish observed
main-thread long tasks from an unsupported browser; they do not measure all JS
execution or explain each task. `hiddenMs` records time hidden since the collector
started, so filter background activity before comparing foreground readiness.
Older browser payloads remain accepted without the optional fields.

For startup/restore phases and Modal cost measurements, see
[Modal cost operations](../../hosted/compadre/docs/modal-cost-operations.md).
