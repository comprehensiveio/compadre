import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "started_by_user_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN started_by_user_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "participants_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
  if (!columns.some((column) => column.name === "external_thread_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN external_thread_json TEXT
    `;
  }

  // Existing attributed messages immediately gain useful sidebar metadata;
  // the normal projection refresh enriches this with whole-Slack-thread
  // participant snapshots on every subsequent message.
  yield* sql`
    UPDATE projection_threads
    SET
      started_by_user_id = (
        SELECT json_extract(message.attribution_json, '$.userId')
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND message.role = 'user'
          AND message.attribution_json IS NOT NULL
        ORDER BY message.created_at ASC, message.message_id ASC
        LIMIT 1
      ),
      participants_json = COALESCE((
        SELECT json_group_array(json(participant.participant_json))
        FROM (
          SELECT json_patch(
            json_object(
              'userId', json_extract(message.attribution_json, '$.userId'),
              'displayName', json_extract(message.attribution_json, '$.displayName'),
              'origins', json_array(json_extract(message.attribution_json, '$.origin'))
            ),
            CASE
              WHEN json_extract(message.attribution_json, '$.avatarUrl') IS NOT NULL
                THEN json_object(
                  'avatarUrl', json_extract(message.attribution_json, '$.avatarUrl')
                )
              ELSE json('{}')
            END
          ) AS participant_json
          FROM projection_thread_messages AS message
          WHERE message.thread_id = projection_threads.thread_id
            AND message.role = 'user'
            AND json_extract(message.attribution_json, '$.userId') IS NOT NULL
          GROUP BY json_extract(message.attribution_json, '$.userId')
          ORDER BY MIN(message.created_at) ASC
        ) AS participant
      ), '[]'),
      external_thread_json = (
        SELECT json_object(
          'provider', 'slack',
          'url', json_extract(message.attribution_json, '$.slack.threadUrl')
        )
        FROM projection_thread_messages AS message
        WHERE message.thread_id = projection_threads.thread_id
          AND json_extract(message.attribution_json, '$.slack.threadUrl') IS NOT NULL
        ORDER BY message.created_at ASC, message.message_id ASC
        LIMIT 1
      )
  `;
});
