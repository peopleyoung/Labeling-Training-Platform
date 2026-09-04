CREATE TABLE IF NOT EXISTS training_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  job_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot JSONB NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS snapshot_id TEXT REFERENCES training_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE model_versions ADD COLUMN IF NOT EXISTS snapshot_id TEXT REFERENCES training_snapshots(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS training_snapshots_dataset_idx ON training_snapshots(dataset_id, created_at DESC);
