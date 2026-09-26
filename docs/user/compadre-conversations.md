# Conversations in Compadre

The composer uses rich text by default. Follow-ups entered during a turn default
to Queue and are sent at the next supported opportunity. Use Send now to steer
immediately, or return a queued message to the composer to edit or cancel it.
Settings → General controls the composer and follow-up preferences.

Responses default to showing finished paragraphs. Provider reasoning appears in
the conversation alongside tool activity and remains available after reload.
Shared conversations retain the identity of the person who submitted each message.

PR file review checkmarks belong to the signed-in Compadre user. Checking or
unchecking a file does not change another person's progress. PR links and the
conversation itself remain shared.

Hosted Compadre does not expose automatic local worktree cleanup, per-thread
auto-settle opt-outs, active thread reordering, question-response attachments,
PR stack mutation, or conversation/checkpoint rollback until their ownership and
Modal execution paths are implemented. Normal message attachments, shared PR
linking/unlinking, and supported provider compaction remain available.

Hosted execution supports Codex and Claude. Other upstream providers, including
Antigravity, remain unavailable until their Modal execution paths are implemented.
