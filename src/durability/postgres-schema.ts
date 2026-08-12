/** Legacy bootstrap retained while the Drizzle migration baseline rolls out. */
export const POSTGRES_DURABILITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS compadre_ai_runs (
  run_id text PRIMARY KEY,
  thread_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'interrupted', 'completed', 'failed', 'aborted')
  ),
  started_at_ms bigint NOT NULL,
  finished_at_ms bigint,
  error jsonb,
  usage jsonb,
  sandbox_key text,
  detached_since_ms bigint,
  cancel_requested boolean,
  driver_epoch bigint
);

CREATE INDEX IF NOT EXISTS compadre_ai_runs_thread_started_idx
  ON compadre_ai_runs (thread_id, started_at_ms);

CREATE INDEX IF NOT EXISTS compadre_ai_runs_reclaimable_idx
  ON compadre_ai_runs (detached_since_ms)
  WHERE status = 'running' AND detached_since_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS compadre_ai_streams (
  run_id text PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1,
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS compadre_ai_stream_events (
  run_id text NOT NULL REFERENCES compadre_ai_streams(run_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  chunk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence)
);
`;
