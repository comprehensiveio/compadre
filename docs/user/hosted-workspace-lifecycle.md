# Hosted workspace lifecycle

An idle hosted worker can expire while your conversation and saved files remain
available. This does not require action and does not show an error banner.

Sending a message or opening the thread's development preview restores its saved
workspace when a checkpoint is available. Reading history and saved diffs does
not start a worker. Interrupted runs and failed restore attempts still report
errors.
