---
name: debug-compadre-workflows
description: Investigate and improve Compadre's Slack-to-Daytona execution when agent runs stop, reset, time out, exhaust memory, fail to open PRs, or surface incomplete Slack responses. Use while developing or operating the Compadre repository, not as a skill executed by Compadre against customer application code.
---

# Debug Compadre Workflows

Trace failures across the complete execution boundary:

```text
Slack thread -> compadre-relay -> execution controller -> harness process tree
```

The persistent Render relay is the execution controller and supervises a
Daytona sandbox. Correlate the Compadre run ID, Daytona sandbox ID, and
host-tool bridge lifecycle. Native repository tools run in Daytona; bridged MCP
and private-network tools still run in the relay.

Do not infer that the relay failed merely because Slack says a run stopped. The
relay can remain healthy while Daytona provisioning, the harness process, or an
authenticated tool request fails.

## Correlate one run

1. Read the complete Slack thread. Record its channel ID, parent `threadTs`, run start time, failure time, and streaming message timestamp.
2. Search `compadre-relay` logs around that window using the Slack `threadTs`
   or run ID. Record sandbox creation, bridge registration, first-event, and
   terminal lifecycle messages.
3. Inspect the matching Daytona sandbox and audit log using its sandbox ID.
   Distinguish provisioning failure, setup failure, harness exit, controller
   cancellation, and destroy failure.
4. Check `[workflow-agent] run failed` for the bounded,
   environment-secret-redacted error message, stack, cause, elapsed time,
   provider, and repository revision.
5. For a tool failure, correlate the bridge ID and HTTP status without logging
   its bearer token, arguments, or result.
   If the bridge registers but receives no request, inspect whether the harness
   received an MCP server configuration and probe its complete per-run bridge
   URL from inside the sandbox without credentials. An HTTP 401 proves routing
   reached bridge authentication; a connection failure or different status
   distinguishes DNS, TLS, tunnel, egress, and route failures before bearer
   validation.
6. Correlate deploys or configuration changes only after identifying which
   boundary failed.

Prefer exact identifiers and narrow time windows. Render service instance suffixes such as `web-8cv7x` are ephemeral; use the stable host/service identity and discovered IDs instead of copying an old suffix.

## Interpret the evidence

- For Daytona, distinguish controller failure, sandbox lifecycle failure,
  harness command exit, and authenticated host-tool bridge failure. A tool
  bridge error does not prove that the sandbox or private service failed.
- A caught harness error should produce `[workflow-agent] run failed`. Its
  absence does not prove success: sandbox termination can bypass JavaScript
  cleanup.
- Compare observed duration with `src/agent-timeouts.ts` and Daytona auto-stop
  configuration before calling a failure a timeout.
- `message_not_in_streaming_state` during `chat.stopStream` is normally a secondary Slack-finalization error after the task has already failed. Do not report it as the root cause without contrary evidence.
- A database connection/disconnection log containing the word `compadre` is not necessarily an agent-run log. Confirm host, service, run ID, and time.

When evidence cannot distinguish OOM, platform termination, and harness exit, say exactly which signals are missing. Do not upgrade timing coincidence into certainty.

## Preserve diagnosability

Keep diagnostic logs structured, bounded, and free of prompts, message bodies, credentials, command arguments, and tool output. Process names from `comm` are acceptable; full `args` are not. Prefer existing telemetry and process observers over adding overlapping timers.

When changing this execution path, verify the TypeScript build, targeted tests
for the touched boundary, and the full test suite. Confirm that hard-kill paths
still leave useful evidence outside the killed process, usually relay lifecycle
logs and Daytona audit metadata.

## Keep this skill current

Treat this as a living developer runbook. If an investigation teaches you a reusable query, identifier mapping, failure mode, misleading symptom, observability gap, or correction, update this skill in the same change when doing so is in scope. Remove or revise stale guidance rather than accumulating contradictory notes. Do not add incident-specific user content, secrets, volatile instance IDs, or conclusions that are not supported by repeatable evidence.
