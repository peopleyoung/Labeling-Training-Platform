ALTER TABLE conversion_jobs ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE training_jobs ADD COLUMN IF NOT EXISTS artifact_id TEXT REFERENCES artifacts(id);

CREATE INDEX IF NOT EXISTS model_versions_artifact_idx ON model_versions (artifact_id);
CREATE INDEX IF NOT EXISTS conversion_jobs_artifact_idx ON conversion_jobs (artifact_id);
