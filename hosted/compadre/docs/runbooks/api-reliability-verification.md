# API reliability verification

Agents can verify canonical conversation delivery without browser automation.
These controller routes require `Authorization: Bearer <COMPADRE_API_KEY>` and
return `Cache-Control: no-store`. They are enabled with the hosted directory.
Keep the credential server-side; never put it in a URL, transcript, or shell trace.

## Create and exercise a canary

`GET /internal/operations/verification` lists central project IDs/default models
and the supported scenario names. Native model catalogs are also available via
the existing authenticated `/hosted/t3/providers/<provider>/models` routes.

1. `POST /internal/operations/verification` with
   `{"projectId":"<central project id>","modelSelection":{"instanceId":"codex","model":"<available model>"}}`.
   The response is `201 {threadId}`. `claudeAgent` is also supported. This creates
   an empty central thread, not a Modal worker. The server chooses a `verify-`
   ID and records its eligibility for fault injection; ordinary threads cannot
   be opted in. Use the same configured project as normal hosted conversations.
2. `POST /internal/operations/verification/<threadId>/turn` with
   `{"messageId":"<unique probe id>","scenario":"delivery-ack-lost"}`.
   The default prompt asks for exactly `VERIFICATION_OK`, without tools or file
   changes. Optional `text` and `inputFiles` use the normal input-file format
   (`name`, `mimetype`, `sizeBytes`, `dataBase64`). Input bytes are uploaded to the
   normal attachment storage; they are not stored in the verification record.
   Starting a turn performs real provider work and incurs ordinary worker/model
   costs. Reusing a message ID already present in the thread does not resend it.
3. `GET /internal/operations/verification/<threadId>` returns `central`
   (the same persisted thread snapshot clients render), `run`, `delivery`
   (epoch/cursor/block), `workflow` (status/pending attempts), and `verification`
   (scenario/remaining/injectedAt/expiry), and `requestStorage` (reference-only
   file metadata and `containsInlineBytes`, never file contents). Reads never provision or restore a
   worker. Inspect these together; a completed run alone is not delivery proof.
4. `POST /internal/operations/verification/<threadId>/resume-delivery` clears
   any armed fault and starts the existing epoch's consumer at its retained
   cursor. It does not send another user message or rerun the provider. A running
   consumer is left running. Wait until a failed consumer is terminal before
   requesting recovery.
5. `POST /internal/operations/verification/<threadId>/stop` cancels active work,
   requests delivery cancellation, clears the fault, and stops the central
   session. Verify terminal workflow/run state with GET afterward. This does
   **not** delete the transcript or destroy the Modal sandbox; the ordinary
   worker lifetime still applies. Reuse canary threads to avoid unnecessary workers.

All faults are consumed at most once and expire ten minutes after arming.
There are no database-crash, global-disconnect, credential-change, or arbitrary
production-thread fault endpoints.

| Scenario | Injection boundary | Expected proof |
| --- | --- | --- |
| `none` | No fault | Terminal central session and one final response |
| `delivery-transient` | Before central append, retryable error equivalent to HTTP 503 | `injectedAt` set, automatic catch-up, one final response |
| `delivery-rejected` | Before central append, permanent error equivalent to HTTP 403 | Blocked delivery retains cursor; central session becomes error; explicit resume delivers pending output |
| `delivery-ack-lost` | After a successful central append but before cursor advancement | Retry resends the same events; no duplicate messages; cursor catches up |
| `request-persistence-failed` | After input object upload, before saving request metadata | No running controller run; central error instead of indefinite starting |

The 403/503 scenarios inject equivalent controller-side failures; they do not
change central authentication or reproduce a load balancer's rejection. The
lost-ack scenario really performs the central append before dropping its ack.
Use separate canaries for independent scenarios, or stop/recover the previous
scenario before another turn. Concurrent scenario changes on the same canary
are not a supported verification workflow.

For image storage, send ten images and inspect GET's `requestStorage`: each file
has an `objectKey` and SHA-256, and `containsInlineBytes` is false. References
remain after terminal completion. Verify the private `compadre` bucket
object's existence and normal attachment access. The GET endpoint deliberately
does not expose object bytes or storage credentials.

## Recovery implementation and rollout limits

New request attachments use the existing private artifact bucket under
`attachments/native-inputs/v1/<hashed-run-id>/<sha256>`. Missing object storage
fails the request; there is no inline database fallback. Files remain limited
to 50 MiB each, with a 100 MiB aggregate request limit. Uploads and reads are
sequential. Existing inline requests remain readable and terminal trimming
removes their attachment data. This is not a bulk backfill of historical rows.

New delivery workflow executions retry transient failures at most five attempts;
permanent HTTP 4xx failures other than 408/425/429 do not retry. On exhaustion
or cancellation, a separately bounded activity records the block and replaces
a stale starting/running central session with an error. Already-settled central
sessions are preserved, including completion whose acknowledgment was lost.
If central remains unreachable, the durable block and
failed Temporal workflow remain evidence requiring operator recovery. The saved
cursor is never advanced by a failure or by the block operation.

The Temporal patch preserves old histories; it cannot retroactively replace
retry options on an already scheduled activity. Healthy old consumers adopt
the new policy on continue-as-new. Cancel/recover old pathological consumers
explicitly. A failed epoch can be resumed without resetting its cursor.

Deploy the web change before controller failure publication to retain the
explanatory error status (older web versions close as stopped). Object-reference
requests require updated controller readers: stage reader support before
switching writers during a mixed-version rollout. Do not roll back to a reader
that understands only inline files while referenced requests are live.

Pre-dispatch runtime errors retry SQL failures five times with exponential
backoff (31 seconds of delay), using stable command IDs. This covers brief
database recovery, not indefinite persistence outages or durable ingress across
a hard process kill. Native worker output retains its existing durable journal.
Request-before-run ordering removes the failed-request-write orphan; the
separate run-create/workflow-launch crash window still needs reconciliation.
Database sizing, managed restart/memory alerts, and historical orphan recovery
are separate operational work, not completed by deploying these code changes.
