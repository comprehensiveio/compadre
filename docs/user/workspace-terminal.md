# Workspace terminal

In a hosted Compadre thread, the terminal opens a shell in that thread's worker
workspace. It shares files with the agent.

Opening the thread or terminal panel does not start a stopped workspace. Select
**Start terminal** to start or restore it. **Reconnect** only tries to attach to
an already-running workspace.

Refreshing the page or hiding the panel leaves the shell running. Closing a
terminal tab ends that shell and attempts to save the worker filesystem. If an
agent is running, its completion saves the filesystem instead. A worker that has
stopped cannot resume its old shell process; restoration starts a new shell.

Manual terminal edits appear in saved diffs after the next agent turn. The saved
diff timestamp tells you when that view was captured.
