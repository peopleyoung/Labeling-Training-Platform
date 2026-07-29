CREATE TABLE IF NOT EXISTS training_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS training_events_job_created_idx ON training_events (job_id, created_at, id);
