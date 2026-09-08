# Hosted preview indicator

In Compadre, a static blue globe beside a sidebar thread title means its
development preview was recently observed responding. Click it to open that
thread's authenticated preview in a new tab. The tooltip reads “Preview ready.”

The globe disappears when the preview is stopped, unresponsive, unknown, or
the observation expires. Its absence does not mean that the conversation or
saved workspace is gone. Checking sidebar readiness never starts a workspace;
opening the preview can start or restore it if it has stopped since the check.

The existing teal terminal indicator still describes a running subprocess in
a managed terminal. Container lifetime and agent activity are separate from
preview readiness.
