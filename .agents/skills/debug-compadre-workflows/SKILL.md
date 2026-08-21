---
name: debug-compadre-workflows
description: Investigate and improve Compadre's Slack-to-Render Workflow execution when agent runs stop, reset, time out, exhaust memory, fail to open PRs, or surface incomplete Slack responses. Use while developing or operating the Compadre repository, not as a skill executed by Compadre against customer application code.
---

# Debug Compadre Workflows

Trace failures across the complete execution boundary:

```text
Slack thread -> compadre-relay -> Render Workflow task -> harness process tree
```

Do not infer that the relay failed merely because Slack says a run stopped. The relay can remain healthy while the ephemeral Render Workflow task fails.

## Correlate one run

1. Read the complete Slack thread. Record its channel ID, parent `threadTs`, run start time, failure time, and streaming message timestamp.
2. Search `compadre-relay` logs around that window using the Slack `threadTs` or run ID. Find the Render `taskRunId` in either `[workflow-relay] Render Workflow task failed` or the older `Render Workflow task ... ended with status failed` message.
3. Inspect the Render task metadata logged by the relay: status, attempts, retries, parent/root task IDs, and `waitMs`.
4. Search the Workflow logs by run ID. Use `[process-monitor]` samples to compare:
   - `tree-rss-mib`: the harness process and its descendants.
   - `cgroup-mib` and `cgroup-limit-mib`: total Workflow-container usage and limit.
   - `cgroup-percent`: memory pressure immediately before termination.
5. Check `[workflow-agent] run failed` for the bounded, environment-secret-redacted error message, stack, cause, elapsed time, provider, and repository revision.
6. Correlate deploys or configuration changes only after identifying which boundary failed.

Prefer exact identifiers and narrow time windows. Render service instance suffixes such as `web-8cv7x` are ephemeral; use the stable host/service identity and discovered IDs instead of copying an old suffix.

## Interpret the evidence

- Relay instance continuity, low relay resource usage, and a terminal Render task status indicate a worker-side failure.
- A rising `cgroup-percent` near 100% followed by missing worker finalization is strong OOM evidence. Process-tree RSS can be lower than cgroup usage because setup tools and unrelated descendants may also consume memory.
- A caught harness error should produce `[workflow-agent] run failed`. Its absence does not prove success: OOM or SIGKILL can bypass JavaScript cleanup.
- Compare observed duration with `src/agent-timeouts.ts` and the task registration in `src/workflows/tasks.ts` before calling a failure a timeout.
- `message_not_in_streaming_state` during `chat.stopStream` is normally a secondary Slack-finalization error after the task has already failed. Do not report it as the root cause without contrary evidence.
- A database connection/disconnection log containing the word `compadre` is not necessarily an agent-run log. Confirm host, service, run ID, and time.

When evidence cannot distinguish OOM, platform termination, and harness exit, say exactly which signals are missing. Do not upgrade timing coincidence into certainty.

## Preserve diagnosability

Keep diagnostic logs structured, bounded, and free of prompts, message bodies, credentials, command arguments, and tool output. Process names from `comm` are acceptable; full `args` are not. Prefer existing telemetry and process observers over adding overlapping timers.

When changing this execution path, verify the TypeScript build, targeted tests for the touched boundary, and the full test suite. Confirm that hard-kill paths still leave useful evidence from outside the killed process, usually relay task metadata and the last process-monitor sample.

## Keep this skill current

Treat this as a living developer runbook. If an investigation teaches you a reusable query, identifier mapping, failure mode, misleading symptom, observability gap, or correction, update this skill in the same change when doing so is in scope. Remove or revise stale guidance rather than accumulating contradictory notes. Do not add incident-specific user content, secrets, volatile instance IDs, or conclusions that are not supported by repeatable evidence.
