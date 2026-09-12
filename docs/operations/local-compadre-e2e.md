# Local Compadre end-to-end environment

Use this environment for ordinary Compadre changes and upstream integrations that
cross the hosted execution boundary. It runs the actual web app, central server,
controller, and Temporal worker, with real Modal sandboxes. Unit tests and the
fake-Modal Temporal probe are separate, faster checks; neither substitutes for
this flow.

## Start

Use an isolated worktree containing the change. Install root dependencies with
`vp i`, and controller dependencies with `npm ci` in `hosted/compadre`.
The host needs Docker Compose, Node, Vite+, the Temporal CLI, and `cloudflared`.
Do not put a controller `.env.local` in the test worktree: the launcher refuses it
to prevent the application's dotenv loader from importing production settings.

Run from the worktree root:

```sh
node scripts/compadre-e2e.mjs up --credentials /absolute/path/to/development.env
```

The credential file must contain `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and
`ANTHROPIC_API_KEY`. Optional Codex credentials are `CODEX_API_KEY`,
`OPENAI_API_KEY`, or the existing `CODEX_AUTH_JSON_BASE64` subscription seed.
The launcher selects only these keys. It does not inherit production databases,
Slack tokens, cloud storage credentials, telemetry credentials, or controller
URLs. Modal credentials must resolve to Comprehensive's `comprehensiveio`
workspace. Real provider calls and Modal resources incur normal development cost.

The launcher also seeds an **E2E fixture** project with a local clone of the same
public repository and `master` branch used by Modal, defaulting to Claude Sonnet. It prints its
private state directory, then the web URL once the
services are ready. Keep the foreground process alive while testing. Run the
printed login command in another terminal:

```sh
node scripts/compadre-e2e.mjs login --state /printed/state/directory --user alice
```

Open the resulting one-time URL. To test another user, issue a separate login
with `--user bob` and use a separate browser profile/session. These identities
are synthetic records in the disposable database. The helper issues a normal
one-time login grant through the application service; central T3 consumes it
through the real controller exchange and creates its normal browser cookie.
Slack OIDC itself is not exercised, and no production login bypass is added.
Do not include the grant URLs or `private.json` in screenshots or shared reports.

## How the pieces connect

| Component             | Where it runs                | Connection/owner                                                                                              |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Web                   | Host, Vite                   | Printed origin; same-origin proxies to central T3                                                             |
| Central T3            | Host, this worktree's source | Dedicated home directory; `compadre_t3` schema in disposable Postgres                                         |
| Controller            | Host, this worktree's source | Independent loopback port; `public` schema in the same disposable Postgres                                    |
| Postgres              | Compose, PostgreSQL 17       | Random loopback port; database `compadre_e2e_test`                                                            |
| Temporal              | Compose                      | Independent frontend port, namespace, and PostgreSQL 16 store                                                 |
| S3                    | Compose, LocalStack          | Dedicated local bucket and fake credentials; a separate temporary tunnel makes object URLs reachable by Modal |
| Modal worker          | Comprehensive Modal          | Unique E2E application, public Hello-World fixture checkout, packaged integration build                       |
| Worker tool callbacks | Temporary Cloudflare tunnel  | Forwards to this test controller; authenticated by a generated E2E credential                                 |

The launcher sets both directions explicitly: central's `COMPADRE_NATIVE_T3_URL`
and `COMPADRE_CONTROLLER_URL` point to the local controller;
controller's `COMPADRE_T3_CENTRAL_URL` points to central's server port and
`COMPADRE_T3_HOSTED_APP_URL` points to Vite. It issues a separate scoped central
bearer session for controller calls. `COMPADRE_PUBLIC_URL` is the temporary
tunnel reachable by Modal. Never set `VITE_HTTP_URL` or `VITE_WS_URL`.

Both database migration histories run before application startup. Central runs
with `COMPADRE_T3_REACTOR_MODE=single-process`. Compose project names, volumes,
ports, Temporal namespaces, and Modal application names are unique per launch.
The controller's Slack ingress and automatic development-template builds are off.
Cloudflare starts with an explicit empty config, so a maintainer's global tunnel
credentials/ingress cannot redirect this environment. A Node preload supplies a
DNS fallback only for this launch's quick-tunnel hostnames when OS lookup returns
ENOTFOUND but DNS resolution succeeds. It does not change system DNS or localhost
resolution. Both public object access and local server readiness are checked
before the launcher reports success.

The launcher compiles controller helper executables, builds the central server, and packs it into a local npm archive, then sets
`COMPADRE_T3_PACKAGE_PATH`. This tests uncommitted integration code in Modal;
it does not silently use the published production archive. `manifest.json`
records the archive SHA-256 and checkout location. Start a fresh environment to
verify changed worker code; hot reload of the local server does not update an
already-running worker.

Local S3 proves the SDK/storage integration, not AWS IAM, networking, or managed
storage behavior. `AWS_ENDPOINT_URL_S3` points to its temporary tunnel and the
S3 adapters use path-style addressing for that custom endpoint, so presigned
object URLs are reachable by Modal. The exposed emulator contains only synthetic
test data and fake credentials; never copy real user data or production secrets
into it. Verify an actual attachment transfer before claiming that flow passed.

## Validate one complete flow

1. Log in as Alice and create a Claude conversation. Send a small task that reads
   the fixture repository. Require an actual completed answer in the browser.
2. Correlate the canonical thread, controller run, Temporal workflow, worker ID,
   and terminal central projection. Check the worker archive fingerprint.
3. Reload and reopen the conversation. Confirm stored history remains available
   without provisioning another sandbox.
4. Log in as Bob. Confirm shared history and correct actor attribution, then
   exercise any changed personal preference independently.
5. Add change-specific proofs: attachments, questions, compaction, cancellation,
   terminal output/input, reconnect, restart, or worker restore. Test Codex
   separately when provider parity is in scope and credentials are supplied.

Record exact flows that passed and those not attempted. Infrastructure readiness
and green unit tests alone are not a completed end-to-end proof. For upstream
integrations, also verify an existing worker version against the new central
server and review schema compatibility before calling the change deploy-ready.

## Logs and lifecycle

Each process writes a named log in the printed state directory. `private.json`
contains generated local credentials and selected provider credentials; the
directory and file are private to the current OS user. `manifest.json` is the
non-secret topology/fingerprint record. Keep incident evidence outside the repo.

Ctrl-C stops only the process groups started by this launcher and stops its own
Compose project. Volumes and logs are retained for inspection. Modal workers are
created only when a turn requests one and have a one-hour lifetime. A test ending
is not evidence that its sandbox has already terminated; record or explicitly
terminate the exact test sandbox when finishing early. Never delete production
resources or stop unrelated developer processes.

After stopping the launcher, remove only its disposable Compose containers and
volumes with:

```sh
node scripts/compadre-e2e.mjs cleanup --state /printed/state/directory
```

This preserves logs and does not terminate Modal sandboxes. The Compose bootstrap
record is written before provisioning, so cleanup also works for failed launches.

When a launch fails, inspect the named failing log. Fix the cause and launch a
fresh isolated environment. Do not point the test at production to work around
missing local configuration.
