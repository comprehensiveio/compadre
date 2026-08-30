# Compadre domain context

## Central T3

The long-lived T3 server and web application on Render. Central T3 owns the
canonical conversation, including messages, turns, activities, and eventually
users and message actors.

## Canonical thread

One conversation address shared by the web, Slack, and HTTP entrypoints. A
canonical thread is bound to one native provider and one isolated Worker.

## Worker

The Modal environment assigned to one canonical thread. It owns the checkout,
native Codex or Claude Code process, live shell state, and provider transcript.

## Native T3 run

One provider turn initiated by Central T3 and executed by a Worker through the
Compadre controller. Its run ID is globally unique and idempotent. Compadre
Postgres owns its lifecycle record, cancellation intent, and ordered event log.

## Run event log

The append-only Postgres record of events produced by one Native T3 run. It is
the delivery authority for subscribers and assigns opaque, ordered resume
cursors. A completed conversation is still rendered from Central T3, not by
querying this log.

## Subscriber

A temporary reader of a run event log, such as Central T3's remote-provider
adapter. Disconnecting a subscriber does not express cancellation and must not
stop the Native T3 run.

## Actor

The authenticated person or system responsible for a conversation message or
command. The protocol reserves actor metadata, but Compadre does not create a
trusted Actor until user or Slack authentication is implemented.

## Controller

The Compadre process on Render. It routes canonical threads, provisions Workers,
coordinates Native T3 runs, hosts tool callbacks, and projects Worker output
into the run event log.
