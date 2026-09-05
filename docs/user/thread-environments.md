# Thread environments

Open **Thread environments** from the main sidebar, or search for it in the
command palette. The hosted Compadre page remains at `/operations/threads`.

The list defaults to latest thread activity first. Container housekeeping and
readiness checks do not change this order. Select **Newest created** to browse
by thread creation instead. Filters and search work together; the compact count
shows matching threads without a separate summary dashboard.

Each row separates agent activity (starting, thinking, generating, using a tool,
waiting for approval/input, idle, or a terminal outcome) from the container,
dev server, and development database. Activity comes from the latest available
run events. Long silence is displayed as elapsed time, not proof of a dead
agent. Waiting labels require a provider-emitted request event.

Container observations and local readiness checks are cached for 30 seconds,
with a limited number checked concurrently. The page refreshes while visible.
An initial **Unknown** means an observation is not available yet; **Stale** means
the last check is over a minute old. A recorded container state is distinguished
from an observed running container. Opening this page never starts services,
restores workers, or extends their warm leases.

**Ready** means the dev server returned a successful HTTP response or redirect,
or local PostgreSQL accepted connections. Database readiness does not verify
migrations, seed contents, or application queries. A suspended container has
stopped services; snapshot availability does not establish database integrity.

Expand a row for IDs, provider/model, lifecycle timestamps, recent run events,
and copy shortcuts. The preview link explicitly indicates when opening it may
start the environment. The thread title opens its conversation.
