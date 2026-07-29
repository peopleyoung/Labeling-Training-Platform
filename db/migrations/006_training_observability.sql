CREATE TABLE IF NOT EXISTS training_metrics (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  progress INTEGER NOT NULL CHECK (progress >= 0 AND progress <= 100),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, epoch)
);

CREATE INDEX IF NOT EXISTS training_metrics_job_epoch_idx ON training_metrics (job_id, epoch);

CREATE TABLE IF NOT EXISTS training_resource_samples (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
  device TEXT NOT NULL CHECK (device IN ('cpu', 'gpu')),
  cpu_percent REAL NOT NULL CHECK (cpu_percent >= 0),
  memory_used_mb REAL NOT NULL CHECK (memory_used_mb >= 0),
  memory_total_mb REAL,
  gpu_percent REAL,
  gpu_memory_used_mb REAL,
  gpu_memory_total_mb REAL,
  gpu_power_watts REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS training_resource_samples_job_created_idx ON training_resource_samples (job_id, created_at, id);
